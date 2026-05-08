# NibePi

> This is a fork of [anerdins/nibepi](https://github.com/anerdins/nibepi) with the following improvements:
> - **Graceful Modbus handover** on Node-RED restart — keeps the serial port alive as a zombie process so the heat pump does not raise a communication alarm (requires a systemd `KillMode=process` drop-in, see below)
> - **MQTT Home Assistant discovery** with `unique_id` and device grouping so entities can be managed in the HA UI
> - **MQTT auto-reconnect** — re-publishes discovery payloads automatically after broker restart
> - **Invalid sensor value filtering** — suppresses NIBE `0x8000` sensor-fault sentinel and physically implausible readings
> - **German UI** — all Node-RED dashboard and system messages translated to German

![NibePi](https://github.com/bebben88/NibePi/blob/master/pics/nibepi-pic.jpg)

NibePi is an IoT product for your NIBE heat pump. Using a Raspberry Pi Zero W and an RS485 HAT, NibePi communicates with the pump over Modbus. It fits inside the heat pump casing and is powered directly from the pump's circuit board.

Supported models: F370, F470, F730, F750, F1145, F1155, F1245, F1255, VVM225, VVM310, VVM320, VVM325, VVM500, SMO20, SMO40

The system runs Node.JS and Node-RED. The root filesystem is mounted read-only to protect the SD card from corruption — settings are only written when you explicitly save them in the UI.

---

## Hardware

**Raspberry Pi Zero W**
- https://thepihut.com/products/raspberry-pi-zero-w
- https://www.kiwi-electronics.nl/raspberry-pi-zero-w

**RS485 HAT**
- https://thepihut.com/products/rs485-pizero?variant=26469099976
- https://www.kiwi-electronics.nl/rs-485-pi
- https://www.abelectronics.co.uk/p/77/rs485-pi

**12V power HAT**
- https://thepihut.com/products/wide-input-shim
- https://www.kiwi-electronics.nl/wide-input-shim

Solder terminals on A and B of the RS485 board, then stack all boards together as tightly as possible to minimise height.

---

## Installation

1. Download the original image from [anerdins.se](http://anerdins.se/NibePi/nibepi_1.1.1.rar) and flash it to a 16 GB SD card.
2. On the boot partition (visible in Windows), edit `wpa_supplicant.conf` with your WiFi credentials:

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

3. Remove the upper filter hatch from the heat pump (exhaust models only).
4. Unscrew the two large Torx T30 screws at the bottom of the front panel, tilt it out and lift it off.
5. Remove the snap-in cover inside the pump.

![inside](https://github.com/bebben88/NibePi/blob/master/pics/nibepi_1.jpg)

6. Connect NibePi to the 12V, A, B and GND terminals. Connections vary by model — consult your manual or [this wiring guide](https://www.nibe.fi/nibedocuments/15050/031725-6.pdf).

![wiring](https://github.com/bebben88/NibePi/blob/master/pics/nibepi_2.jpg)

7. Insert the SD card and start the heat pump with the front panel removed.

**Enable Modbus in the heat pump:**
1. Hold the Back button for ~7 seconds to open the service menu.
2. Navigate to System Settings 5.2.
3. Scroll down and enable **Modbus**.
4. The pump may show a red alarm briefly while NibePi finishes booting.

---

## Accessing NibePi

| Interface | URL |
|---|---|
| Node-RED editor | http://nibepi:1880 |
| Dashboard (UI) | http://nibepi:1880/ui |

If the hostname does not resolve, use the IP address instead (e.g. `http://192.168.1.100:1880`).

---

## Graceful restart setup (required for this fork)

Without this step, every Node-RED restart triggers a NIBE Modbus alarm (error 251 — communication loss). This fork keeps the Modbus connection alive during restarts using a zombie process, but systemd must be told not to kill it:

```bash
sudo mount -o remount,rw /
sudo mkdir -p /etc/systemd/system/nodered.service.d
sudo tee /etc/systemd/system/nodered.service.d/killmode.conf << 'EOF'
[Service]
KillMode=process
EOF
sudo systemctl daemon-reload
```

---

## Deploying updates

Copy files to the Pi, then apply and restart:

```bash
# From Windows (PowerShell)
scp backend.js pi@nibepi:/tmp/backend.js
scp index.js pi@nibepi:/tmp/index.js
scp flows.json pi@nibepi:/tmp/flows.json

# On the Pi
sudo mount -o remount,rw / && \
cp /tmp/backend.js /home/pi/.node-red/node_modules/nibepi/backend.js && \
cp /tmp/index.js /home/pi/.node-red/node_modules/nibepi/index.js && \
cp /tmp/flows.json /home/pi/.node-red/flows.json && \
sudo service nodered restart
```

---

## Credits

Original project by [Fredrik Anerdin](https://github.com/anerdins/nibepi). Licensed under MIT.
