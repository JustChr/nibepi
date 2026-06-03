/*MIT License

Copyright (c) 2019 Fredrik Anerdin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
const version = "1.1.0";
/*var exec = require('child_process').exec;
exec(`sudo chrt -a -f -p 99 ${process.pid}`, function(error, stdout, stderr) {
    if(error) {
        
    } else {
        console.log('High priority backend is started')
    }

});*/
const { SerialPort: serialport } = require('serialport');
const fs = require('fs');
// Pre-allocated constant write frames. serialport does Buffer.from() on every
// write of a plain array; reusing these Buffers avoids a native allocation per
// frame in the hot path (the main driver of glibc brk-heap growth).
const nack = Buffer.from([0x15]);
const ack = Buffer.from([0x06]);
const RMU_VERSION_FRAME = Buffer.from([192,238,3,238,3,1,193]);
const RMU_63_FRAME = Buffer.from([192,96,2,99,0,193]);
var myPort;
const sendQueue = [Buffer.from([192,107,6,115,176,1,0,0,0,111])];
const getQueue = [];
const rmuQueue = [];
var regQueue = [];
var regCount = 0;
const accumBuf = Buffer.allocUnsafe(512); // pre-allocated; NIBE frames are ≤ ~128 bytes
let accumLen = 0;
var rmu_buffer = Buffer.alloc(0);
var red = false;
var fs_start = false;
var rmu_start = false;
let other_start = false;
var startReset = true;
let checkACK = {};
var portName;
var portOpenRetries = 0;
const PID_FILE = '/tmp/nibepi_backend.pid';
let debugMode = false;

function openPort() {
    myPort = new serialport({ path: portName, baudRate: 9600 });
    myPort.on('open', showPortOpen);
    myPort.on('data', analyzeData);
    myPort.on('close', showPortClose);
    myPort.on('error', showError);
}

process.on('message', (m) => {
    if(m.start===true) {
        if(m.port!==undefined) {
            portName = m.port;
            // Kill any zombie instance still holding the serial port
            let hadZombie = false;
            try {
                if(fs.existsSync(PID_FILE)) {
                    const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'));
                    if(oldPid && oldPid !== process.pid) {
                        try { process.kill(oldPid, 'SIGUSR2'); hadZombie = true; } catch(e) {}
                    }
                }
                fs.writeFileSync(PID_FILE, process.pid.toString());
            } catch(e) {}
            // Give the zombie time to close() before we try to open.
            setTimeout(openPort, hadZombie ? 1500 : 0);
        } else {
            if(process.connected===true) {
                process.send({type:"log",data:'Error starting backend, no serial port specified',level:"error",kind:"Serialport"});
            }
        }
    } else if(m.type=="reqData") {
        if(m.data!==undefined) {
            let found = false;
            for (i = 0; i < getQueue.length; i = i + 1) {
                let address = (getQueue[i][4]*256)+getQueue[i][3];
                if((m.data[4]*256)+m.data[3]==address) {
                    found = true;
                }
            }
            if(found===false) getQueue.unshift(Buffer.from(m.data))
        }
        ;
    } else if(m.type=="setData") {
        sendQueue.push(Buffer.from(m.data));
    } else if(m.type=="rmuSet") {
        // .data is written to the port; .ackback/.address are still sent over IPC as arrays
        if(m.data && Array.isArray(m.data.data)) m.data.data = Buffer.from(m.data.data);
        rmuQueue.push(m.data);
    } else if(m.type=="regRegister") {
        // Convert poll frames to Buffers once, so the steady per-token write
        // (the highest-frequency write) reuses them instead of allocating each time.
        regQueue = Array.isArray(m.data) ? m.data.map(f => Buffer.from(f)) : [];
    } else if(m.type=="red") {
        red = m.data;
    } else if(m.type=="debug") {
        debugMode = !!m.data;
    }
  });
  let zombieMode = false;
  function enterZombieMode() {
      if(zombieMode) return;
      zombieMode = true;
      console.log('Graceful shutdown: keeping Modbus alive during restart...');
      // Stay alive so the pump keeps getting ACKs and doesn't raise a communication alarm.
      // The new backend instance will send SIGUSR2 once it has the port.
      setTimeout(() => {
          console.log('Graceful shutdown timeout, exiting.');
          cleanExit();
      }, 600000);
  }

  process.on('disconnect', () => {
      enterZombieMode();
  });

  // Systemd kills backend.js directly via cgroup SIGTERM during nodered restart
  process.on('SIGTERM', () => {
      enterZombieMode();
  });

  // Node-RED sends SIGINT via stopCore() during shutdown
  process.on('SIGINT', () => {
      enterZombieMode();
  });

  // SIGUSR2 is our private signal: sent by the new backend instance when it is ready
  // (SIGUSR1 is reserved by Node.js for the debugger)
  process.on('SIGUSR2', () => {
      console.log('New backend instance ready, handing over serial port.');
      cleanExit();
  });

  function cleanExit() {
      try { if(parseInt(fs.readFileSync(PID_FILE,'utf8'))===process.pid) fs.unlinkSync(PID_FILE); } catch(e) {}
      if(myPort && myPort.isOpen) {
          // Safety timer: if close() hangs (RS485 HAT mid-frame), force exit so the OS
          // releases the file descriptor and the new backend can claim the port.
          const forceExit = setTimeout(() => process.exit(99), 3000);
          forceExit.unref();
          myPort.close(() => { clearTimeout(forceExit); process.exit(99); });
      } else {
          process.exit(99);
      }
  }


function showPortOpen() {
    //console.log(`Core started on serial port ${portName}`);
}
function showPortClose() {
    console.log('Port closed. Data rate: ' + myPort.baudRate);
}
function showError(error) {
    // Port may be held by a zombie instance — retry a few times to let it release
    if(portOpenRetries < 25) {
        portOpenRetries++;
        console.log(`Serial port busy, retry ${portOpenRetries}/25 in 3s...`);
        myPort.removeAllListeners();
        setTimeout(openPort, 3000);
        return;
    }
    if(process.connected===true) {
        process.send({type:"fault",data:{from:"core",message:"The core could not be started, check the serialport"}});
    }
    myPort.removeAllListeners();
    if(process.connected===true) {
        process.disconnect();
        console.log('Error in the core, shuting it down.')
        process.exit(99);
    }
}

function analyzeData(data) {
    if(debugMode && process.connected===true) {
        process.send({type:"log",data:Array.from(data),level:"core",kind:"RAW"});
    }
    // Sometimes an ACK [0x06] is the first byte, and the second byte is the start. We shift it.
    if(data[0]===0x06 && data[1]===0x5C) {
        data = data.slice(1)
    } else if(data[0]===0x06 && data[1]===undefined) {
        // standalone ACK — nothing to accumulate
    }
    //Check for start message, 0x5C if it's Nibe F series.
    if(fs_start===false) {
        if(data[0]===0x5C) {
            fs_start = true;
        }
    }
    if(fs_start===true) {
        // Guard against overflow from corrupted stream
        if(accumLen + data.length > accumBuf.length) {
            accumLen = 0;
            fs_start = false;
            return;
        }
        data.copy(accumBuf, accumLen);
        accumLen += data.length;
        if(accumLen>=3) {
                if(startReset===true) {
                    startReset = false;
                    sendQueue.push(Buffer.from([192,107,6,115,176,1,0,0,0,111]));
                }
                // Only decode objects we know
                if(accumBuf[2]!==0x19 && accumBuf[2]!==0x1A && accumBuf[2]!==0x1B && accumBuf[2]!==0x1C && accumBuf[2]!==0x20) {
                    accumLen = 0;
                    fs_start = false;
                }
                if(accumLen>=5) {
                let msgLength = accumBuf[4]+6;
                // Check if we have the full length of the message.
                if(accumLen>=msgLength) {
                        // We have full length
                        if(accumBuf[2]==0x19 || accumBuf[2]==0x1A || accumBuf[2]==0x1B || accumBuf[2]==0x1C) {
                            if(checkACK[accumBuf[2]]===undefined) {
                                if(accumLen>=6) {
                                    if(accumBuf[accumBuf[4]+6]===0x06 || accumBuf[accumBuf[4]+6]===0xC0) {
                                        checkACK[accumBuf[2]] = true;
                                        accumLen = 0;
                                        fs_start = false;
                                    } else {
                                        checkACK[accumBuf[2]] = false;
                                        accumLen = 0;
                                        fs_start = false;
                                    }
                                } else {
                                    msgLength++;
                                }
                                return;
                            }
                        }
                    const frameView = accumBuf.subarray(0, msgLength);
                    try {
                        let result = makeResponse(checkMessage(frameView));
                        if(startReset===false) {
                            result = Array.from(result);
                            let doubleFound = false;
                            for (i = 5; i < result.length - 1; i = i + 1) {
                                if(result[i]===92 && result[i+1]===92) {
                                    result.splice(i, 1);
                                    result[4] = result[4]-1;
                                    doubleFound = true;
                                }
                            }
                            if(doubleFound===true) {
                                var calcChecksum = 0;
                                for(i = 2; i < (result[4] + 5); i++) {
                                    calcChecksum ^= result[i];
                                }
                                result[result.length-1] = calcChecksum;
                            }
                            if(process.connected===true) {
                                process.send({type:"data",data:result,rmu:checkACK[result[2]]});
                                if(debugMode) process.send({type:"log",data:result,level:"debug",kind:"OK"});
                            }
                        }
                    } catch(err) {
                        err = Array.from(err);
                        console.log(`CHKSUM ERROR: ${err}`)
                        if(process.connected===true) {
                            process.send({type:"log",data:err,level:"error",kind:"CHKSUM"});
                        }
                        myPort.write(nack);
                    }
                } else {
                    // Message is not ready yet.
                }
            }
        }
    }
}



function checkMessage(data) {
    accumLen = 0;
    fs_start = false;
    const msgChecksum = data[data[4]+5];
    let calcChecksum = 0;
    for(let i = 2; i < (data[4] + 5); i++) {
        calcChecksum ^= data[i];
    }
    if((msgChecksum==calcChecksum) || (msgChecksum==0xC5 && calcChecksum==0x5C)) {
        return data;
    } else {
        throw data;
    }
}
function makeResponse(data) {
    // Read from heatpump
    if(data[2]==0x19 || data[2]==0x1A || data[2]==0x1B || data[2]==0x1C) { // < System
        if(data[3]==0x60) { // Send data message
            if(checkACK[data[2]]===false) {
                if(rmuQueue.length!==0) {
                    var lastMsg = rmuQueue.pop();
                    if(lastMsg!==undefined) {
                        if(Number(lastMsg.ackback[2])==Number(data[2])) {
                            let address = lastMsg.address;
                            if(process.connected===true) {
                                process.send({type:"ack",data:{register:address,ack:true}});
                                if(debugMode) process.send({type:"log",data:`Register: ${address}, Buffer: ${JSON.stringify(lastMsg)}`,level:"core",kind:"RMU SENT"});
                            }
                            if(lastMsg.data[3]===6) {
                                if(process.connected===true) {
                                    process.send({type:"data",data:lastMsg.ackback,rmu:checkACK[lastMsg.ackback[2]]});
                                    if(debugMode) process.send({type:"log",data:lastMsg,level:"debug",kind:"RMU ACKBACK"});
                                }
                            }
                            myPort.write(lastMsg.data);
                        } else {
                            rmuQueue.push(lastMsg);
                            myPort.write(ack);
                        }
                    } else {
                        myPort.write(ack);
                    }
                } else {
                    myPort.write(ack);
                }
            }
            return data;
        } else if(data[3]==0x62) {
            // Message updates
            if(checkACK[data[2]]===false) {
                if(debugMode && process.connected===true) {
                    let logOut = Array.from(data);
                    process.send({type:"log",data:logOut,level:"debug",kind:"RMU DATA"});
                }
                myPort.write(ack);
            }
            return data;
        } else if(data[3]==0x63) {
            if(checkACK[data[2]]===false) {
                myPort.write(RMU_63_FRAME);
            }
            return data;
        } else if(data[3]==0xEE) {
            if(checkACK[data[2]]===false) {
                if(debugMode && process.connected===true) {
                    process.send({type:"log",data:"Sending RMU Version v259",level:"debug",kind:"RMU ACK"});
                }
                myPort.write(RMU_VERSION_FRAME);
            }
            return data;
        } else {
            if(checkACK[data[2]]===false) {
                myPort.write(ack);
            }
            return data;
        }
    } else if(data[3]==105 && data[4]==0x00) {
        if(getQueue!==undefined && getQueue.length!==0) {
            var lastMsg = getQueue.pop();
            if(lastMsg!==undefined) {
                myPort.write(lastMsg);
            } else if(getQueue.length!==0) {
                lastMsg = getQueue.pop();
                if(lastMsg!==undefined) {
                    myPort.write(lastMsg);
                } else {
                    myPort.write(ack);
                }
            } else {
                myPort.write(ack);
            }
        } else {
            if(regQueue.length!==0) {
                if(regCount>=regQueue.length) regCount = 0;
                myPort.write(regQueue[regCount]);
                regCount++;
            } else {
                myPort.write(ack);
            }
        }
        return data;
    // Write to heatpump
    } else if(data[3]==107 && data[4]==0x00) {
        if(sendQueue.length!==0) {
            var lastMsg = sendQueue.pop();
            if(lastMsg!==undefined) {
                let address = (lastMsg[4] * 256 + lastMsg[3]);
                if(process.connected===true) {
                    process.send({type:"ack",data:{register:address,ack:true}});
                    if(debugMode) process.send({type:"log",data:`Register: ${address}, Buffer: ${JSON.stringify(lastMsg)}`,level:"debug",kind:"SENT"});
                }
                myPort.write(lastMsg);
            } else {
                myPort.write(ack);
            }
        } else {
            myPort.write(ack);
        }
        return data;
    } else {
        if(data[3]==109) {
        } else if(data[3]==238) {
        } else if(data[3]==106 || data[3]==104) {
        } else {
        }
        myPort.write(ack);
        return data;
    }
}
