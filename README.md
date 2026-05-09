# NibePi

A standalone bridge that connects a NIBE heat pump to Home Assistant via MQTT. Runs on a Raspberry Pi Zero W fitted with an RS485 HAT inside the heat pump casing. No Node-RED, no cloud — ~150 MB less RAM used compared to the original project.

> Fork of [anerdins/nibepi](https://github.com/anerdins/nibepi). Licensed under MIT.

---

## How it works

```
Heat pump  ←→  RS485 HAT  ←→  Raspberry Pi Zero W
                                      │
                               bridge.js (Node.js)
                               ├── backend.js (serial/Modbus child process)
                               ├── MQTT → Home Assistant
                               └── HTTP config UI  :1880
```

`bridge.js` is a single Node.js daemon. It forks `backend.js` to own the RS485 serial port, decodes NIBE F-series Modbus frames, publishes register values to MQTT, and serves a browser-based config UI. Home Assistant auto-discovers all configured sensors, numbers, switches, and selects via MQTT discovery.

---

## Supported pump models

F370, F470, F730, F750, F1145, F1155, F1245, F1255, F1345, F1355,
VVM225, VVM310, VVM320, VVM325, VVM500, SMO20, SMO40, RMU40 (S1–S4), S1255

---

## Hardware

### What you need

| Part | Example suppliers |
|---|---|
| Raspberry Pi Zero W | [thepihut.com](https://thepihut.com/products/raspberry-pi-zero-w) · [kiwi-electronics.nl](https://www.kiwi-electronics.nl/raspberry-pi-zero-w) |
| RS485 HAT | [thepihut.com](https://thepihut.com/products/rs485-pizero?variant=26469099976) · [kiwi-electronics.nl](https://www.kiwi-electronics.nl/rs-485-pi) · [abelectronics.co.uk](https://www.abelectronics.co.uk/p/77/rs485-pi) |
| 12V wide-input power HAT | [thepihut.com](https://thepihut.com/products/wide-input-shim) · [kiwi-electronics.nl](https://www.kiwi-electronics.nl/wide-input-shim) |
| 16 GB microSD card | any brand |
| Micro-USB cable + power supply (for initial setup only) | |

### Assembly

Solder screw terminals on the A and B pads of the RS485 HAT. Stack the boards: Pi Zero W → 12V HAT → RS485 HAT, as flat as possible to fit inside the pump casing.

### Wiring inside the pump

Connect NibePi to the pump's terminal block — exact positions vary by model, consult your manual or [this NIBE wiring guide](https://www.nibe.fi/nibedocuments/15050/031725-6.pdf).

| NibePi terminal | Pump terminal |
|---|---|
| 12V | 12V (or GND-referenced supply rail) |
| GND | GND |
| A | RS485 A |
| B | RS485 B |

---

## Raspberry Pi setup

### 1. Flash the OS

Download the **original NibePi image** from [anerdins.se](http://anerdins.se/NibePi/nibepi_1.1.1.rar) and flash it to the SD card with [Raspberry Pi Imager](https://www.raspberrypi.com/software/) or [balenaEtcher](https://etcher.balena.io/).

The image ships with a read-only root filesystem (plain ext4 mounted ro) to protect the SD card. Settings are only written when you explicitly save them in the UI.

### 2. Configure WiFi

With the SD card still in your PC, open the `boot` partition (visible in Windows) and edit `wpa_supplicant.conf`:

```
ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev
update_config=1
country=DE

network={
    ssid="YOUR_WIFI"
    psk="YOUR_PASSWORD"
    key_mgmt=WPA-PSK
}
```

Eject the card, insert it into the Pi and power it on.

### 3. Find the Pi on your network

The hostname is `nibepi`. Try `ping nibepi` from your PC. If DNS doesn't resolve it, log in to your router to find its IP address.

SSH credentials: `pi` / `nibe`

```bash
ssh pi@nibepi
```

### 4. Expand the filesystem

The image only uses ~3 GB of the card. Expand it to use the full card:

```bash
sudo mount -o remount,rw /
sudo parted /dev/mmcblk0 resizepart 2 100%
sudo resize2fs /dev/mmcblk0p2
sudo mount -o remount,ro /
```

### 5. Install Node.js 18

The image ships with Node.js v10 which is too old. The Pi Zero W uses ARMv6l — use the unofficial builds:

```bash
sudo mount -o remount,rw /

# Download and install Node.js 18 for ARMv6l
wget https://unofficial-builds.nodejs.org/download/release/v18.20.8/node-v18.20.8-linux-armv6l.tar.xz
tar -xf node-v18.20.8-linux-armv6l.tar.xz
sudo cp -r node-v18.20.8-linux-armv6l/bin/* /usr/local/bin/
sudo cp -r node-v18.20.8-linux-armv6l/lib/* /usr/local/lib/
rm -rf node-v18.20.8-linux-armv6l*

node --version   # should print v18.20.8
```

### 6. Add swap (required for npm install)

The Pi Zero W has 512 MB RAM. Compiling the serialport native addon requires extra memory:

```bash
sudo mount -o remount,rw /
sudo fallocate -l 512M /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

> After the install is complete you can remove it: `sudo swapoff /swapfile && sudo rm /swapfile`

---

## Installation

### 1. Copy files to the Pi

From Windows (PowerShell):

```powershell
scp bridge.js              pi@nibepi:/tmp/bridge.js
scp backend.js             pi@nibepi:/tmp/backend.js
scp package.json           pi@nibepi:/tmp/package.json
scp -r ui                  pi@nibepi:/tmp/ui
scp -r lib                 pi@nibepi:/tmp/lib
scp -r models              pi@nibepi:/tmp/models
scp patches/bridge.service pi@nibepi:/tmp/bridge.service
```

### 2. Install on the Pi

```bash
sudo mount -o remount,rw /

# Create install directory
sudo mkdir -p /opt/nibepi
sudo chown pi:pi /opt/nibepi

# Copy files
cp  /tmp/bridge.js    /opt/nibepi/bridge.js
cp  /tmp/backend.js   /opt/nibepi/backend.js
cp  /tmp/package.json /opt/nibepi/package.json
cp -r /tmp/ui         /opt/nibepi/ui
cp -r /tmp/lib        /opt/nibepi/lib
cp -r /tmp/models     /opt/nibepi/models

# Install npm dependencies (~6 minutes on Pi Zero W)
cd /opt/nibepi && npm install

# Install config directory
sudo mkdir -p /etc/nibepi
sudo chown pi:pi /etc/nibepi

# Install systemd service
sudo cp /tmp/bridge.service /etc/systemd/system/bridge.service
sudo systemctl daemon-reload
sudo systemctl enable bridge
sudo systemctl start bridge
```

### 3. Enable Modbus on the pump

1. Hold the **Back** button for ~7 seconds to open the service menu.
2. Navigate to **System Settings 5.2**.
3. Scroll down and enable **Modbus**.
4. The pump may show a brief red alarm while NibePi finishes booting — this is normal.

### 4. Open the config UI

```
http://nibepi:1880
```

---

## Configuration

All configuration is done through the browser UI at `http://nibepi:1880`. Settings are saved to `/etc/nibepi/config.json`.

### Connection tab

| Setting | Description |
|---|---|
| Serial port | RS485 device node, default `/dev/ttyAMA0` |
| Pump series | F-series (all supported models use this) |

The pump model is detected automatically on first connection and saved to config.

### MQTT tab

| Setting | Description |
|---|---|
| Host | IP or hostname of your MQTT broker |
| Port | Default `1883` |
| Username / Password | Optional broker credentials |
| Topic prefix | Base topic for all register values, default `nibe/modbus/` |
| HA Discovery | Enable to auto-publish Home Assistant MQTT discovery messages |

### Register tab

Browse or search all registers for your pump model. Toggle individual registers on to start polling them. Active registers are polled continuously and their live values are shown in the table.

### Status & System tab

| Control | Description |
|---|---|
| Filesystem mode | Toggle root filesystem between read-only (normal) and read-write (for manual edits) |
| Log / Debug | Enable verbose logging and raw Modbus frame output |
| Restart | Restart the bridge service (uses graceful zombie handover — pump stays connected) |
| Live log | Streams the last 500 log lines in real time |

---

## Home Assistant integration

With **HA Discovery** enabled, every active register is automatically published to Home Assistant as a MQTT entity under the device **"Nibe Heat Pump"**:

| Register type | HA entity type |
|---|---|
| Read-only, numeric | `sensor` |
| Read-only, state map (e.g. operating mode) | `sensor` with `value_template` |
| Read/write, numeric | `number` |
| Read/write, binary state map (0/1) | `switch` |
| Read/write, multi-state map | `select` |

Discovery messages are published with `retain: true` and re-published automatically after MQTT broker restart.

MQTT topics follow the pattern:

```
nibe/modbus/<register>        ← current value (published on every update)
nibe/modbus/<register>/set    ← write a value (R/W registers only)
nibe/modbus/<register>/raw    ← raw scaled value
```

---

## Deploying updates

```powershell
# From Windows (PowerShell)
scp bridge.js  pi@nibepi:/tmp/bridge.js
scp backend.js pi@nibepi:/tmp/backend.js
```

```bash
# On the Pi
sudo mount -o remount,rw / && \
cp /tmp/bridge.js  /opt/nibepi/bridge.js && \
cp /tmp/backend.js /opt/nibepi/backend.js && \
sudo systemctl restart bridge
```

Restart is graceful: `backend.js` enters zombie mode to keep the pump connected, and the new instance claims the serial port via SIGUSR2 within a few seconds.

---

## Migrating from the original Node-RED setup

If you are running the original anerdins/nibepi image with Node-RED, you can cut over to bridge.js with zero pump downtime:

```bash
# Stop Node-RED — backend.js enters zombie mode, pump keeps getting ACKs
sudo systemctl stop nodered

# Start bridge — it claims the serial port from the zombie (3–9 s)
sudo systemctl start bridge

# Verify
sudo systemctl status bridge
journalctl -u bridge -f

# Disable Node-RED autostart
sudo systemctl disable nodered
```

---

## Troubleshooting

**Bridge doesn't start / exits immediately**

```bash
journalctl -u bridge -n 50
```

Check that `/usr/local/bin/node` exists and is v18:
```bash
/usr/local/bin/node --version
```

**Serial port busy on startup**

If the previous backend.js left a stale PID file:
```bash
rm -f /tmp/nibepi_backend.pid
sudo systemctl restart bridge
```

**Pump shows communication alarm after restart**

The `KillMode=process` in `bridge.service` is required. Verify:
```bash
grep KillMode /etc/systemd/system/bridge.service
# should print: KillMode=process
```

**MQTT not connecting**

Check broker host/port in the UI. Verify the broker is reachable from the Pi:
```bash
nc -zv <mqtt-host> 1883
```

**Register values not appearing in Home Assistant**

Make sure **HA Discovery** is enabled in the MQTT tab and the register is toggled on in the Register tab. Check Home Assistant → Settings → Devices & Services → MQTT.

---

## Credits

Original project by [Fredrik Anerdin](https://github.com/anerdins/nibepi). Licensed under MIT.
