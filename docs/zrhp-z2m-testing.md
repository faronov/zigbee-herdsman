# Testing Zigbee2MQTT on a zigbee-rs NCP (ZRHP)

[Русская версия](zrhp-z2m-testing.ru.md)

This guide is for testers who already run Zigbee2MQTT and want to try the
[zigbee-rs](https://github.com/faronov/zigbee-rs) network co-processor (NCP) as a Zigbee coordinator. No zigbee-rs or
Rust knowledge is needed: you flash a ready-made firmware image onto an Espressif DevKit, run a **separate, test-only**
Zigbee2MQTT built with this herdsman fork (`adapter: zrhp`), pair a few spare devices, and send the logs back.

Status: experimental. The NCP firmware and this adapter pass their protocol and simulator tests (including Zigbee2MQTT
end to end against the NCP simulator in CI), and the NCP has formed networks and served a joined device on real
ESP32-H2/C6 hardware, but **Zigbee2MQTT on a real NCP has not been run yet** — that is what this test is for (gate H11
of the [ZRHP spec](https://github.com/faronov/zigbee-rs/blob/master/docs/book/src/advanced/host-protocol.md)).

> ### ⚠️ Safety first
>
> - **Back up** your production Zigbee2MQTT `data` directory before you start (copy the whole folder somewhere safe).
> - **Never** point the test Zigbee2MQTT at your production `data` directory, `configuration.yaml`, network key,
>   PAN ID or `coordinator_backup.json`. If the NCP restored your production backup it would become a _second
>   coordinator of your real network_ with higher frame counters, and the devices would then reject your real
>   coordinator's frames as replays. Use `GENERATE` for the network key, PAN ID and extended PAN ID as shown below.
> - Give the test instance its own MQTT base topic and frontend port (`zigbee2mqtt-zrhp`, 8081 below), and keep it out of
>   your production Home Assistant.
> - Pair only **spare** devices. A device paired to the test network leaves your production network; to move it back,
>   factory-reset it and pair it again with your production Zigbee2MQTT.

## 1. Hardware

| Priority        | Board                                                       | Firmware image    | Port to use                                                             |
| --------------- | ----------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| **1 (primary)** | ESP32-H2 DevKit (ESP32-H2-DevKitM-1 or similar, 4 MB flash) | `zrhp-ncp-h2-usj` | the USB-C port labelled **USB**                                         |
| 2               | ESP32-C6 DevKit (ESP32-C6-DevKitC-1, 4 or 8 MB flash)       | `zrhp-ncp-c6-usj` | the USB-C port labelled **USB**                                         |
| secondary       | Espressif Thread Border Router / Zigbee Gateway board       | `zrhp-ncp-h2-br`  | see [section 9](#9-secondary-espressif-thread-border-router-board-uart) |

Test the **H2 first**: it is an 802.15.4-only chip, like the main zigbee-rs target. The C6 also has Wi-Fi, which this
firmware does not use.

Both DevKits have two USB-C connectors:

- **USB** — the chip's native _USB-Serial-JTAG_ port. **Use this one.** The NCP talks ZRHP on it, and esptool flashes
  and resets the chip through it.
- **UART** — a USB-to-UART bridge (CP2102N or CH343) on the chip's UART0. Not used by this firmware (it only carries the
  ROM boot messages). Leave it unplugged.

Over USB-Serial-JTAG the baud rate and flow-control settings are ignored, so you do not configure them.

### Serial device names

| OS      | The **USB** port shows up as                                                                                                                  | The UART port (not used)                                                     |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Linux   | `/dev/ttyACM0`, and better `/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00` (the number is the chip's MAC) | `/dev/ttyUSB0`, `usb-Silicon_Labs_CP2102N…` or `usb-1a86_USB_Single_Serial…` |
| macOS   | `/dev/cu.usbmodemNNNN` (use the `cu.` name, not `tty.`)                                                                                       | `/dev/cu.usbserial-…`, `/dev/cu.wchusbserial…`                               |
| Windows | `COMn` — "USB Serial Device (COMn)" in Device Manager                                                                                         | "Silicon Labs CP210x … (COMn)", "USB-Enhanced-SERIAL CH343 (COMn)"           |

On Linux, check with `ls -l /dev/serial/by-id/` and always use the `by-id` path: after an NCP reset the USB device
re-enumerates and may get another `ttyACM` number. Your user needs access to the port (group `dialout` on
Debian/Ubuntu, `uucp` on Arch).

## 2. Get the NCP firmware

**Easiest — the web flasher:** <https://faronov.github.io/zigbee-rs/flasher/> (Chrome or Edge on a computer; Firefox
and Safari have no Web Serial).

1. Choose the board: **ESP32-H2 DevKit: ZRHP NCP** (primary) or **ESP32-C6 DevKit: ZRHP NCP**.
2. Choose the version — the latest stable one (`recommended`) is selected by default. The page shows the date, commit,
   `build_id`, a link to the release notes and the SHA-256 of every file.
3. The **"Erase the whole chip first"** checkbox:
   - **first installation** (the board runs another firmware, or you want to start from scratch) — **tick it**: the
     chip is erased completely;
   - **update** of an NCP that already holds the test network — **leave it unticked**: the flasher writes only the
     bootloader, the partition table, a blank `otadata` and the application; the `zbnv` partition (network, keys,
     devices) stays. Also leave the checkbox unticked in the next ESP Web Tools dialog ("Erase device?").
4. Connect the DevKit's **USB** port (not UART), click **Install** and pick the port ("USB JTAG/serial debug unit").
   If the port does not show up: hold **BOOT**, press and release **RESET**, release **BOOT**, try again.

The flasher checks that the chip matches the selected board. All images come from the GitHub releases
<https://github.com/faronov/zigbee-rs/releases> (tags `ncp-v…`), not from CI artifacts, so every tester runs the same
build. Name the version in logs and reports (e.g. `ncp-v0.1.0`).

**Without a browser (esptool).** The release page has the same files: `zrhp-ncp-<board>-<version>-merged.bin` (full
4 MB image, written at `0x0`, erases the network), the separate parts and `SHA256SUMS`; the esptool commands are in the
release notes. Use esptool v5 (`write-flash`; v4: `write_flash`) and the files of one release, not mixed with images
from older instructions.

## 3. Flash it with esptool

Only needed without the web flasher. Download the files of one release (e.g. `ncp-v0.1.0`) from
<https://github.com/faronov/zigbee-rs/releases> and check them: `sha256sum -c SHA256SUMS --ignore-missing` (macOS:
`shasum -a 256 -c SHA256SUMS --ignore-missing`).

Install esptool (v5 shown; with esptool v4 the commands are `esptool.py … write_flash` / `erase_flash`):

```bash
python3 -m pip install --upgrade esptool
```

Plug the DevKit's **USB** port into the computer and run (with your port):

```bash
# ESP32-H2 (primary)
PORT=/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00
esptool --chip esp32h2 --port "$PORT" erase-flash
esptool --chip esp32h2 --port "$PORT" write-flash 0x0 zrhp-ncp-h2-usj-0.1.0-merged.bin

# ESP32-C6 (second)
esptool --chip esp32c6 --port "$PORT" erase-flash
esptool --chip esp32c6 --port "$PORT" write-flash 0x0 zrhp-ncp-c6-usj-0.1.0-merged.bin
```

macOS: `PORT=/dev/cu.usbmodemNNNN`; Windows: `--port COM5`.

- esptool puts the chip into download mode and back by itself over USB-Serial-JTAG. If it cannot connect: hold
  **BOOT**, press and release **RESET**, release **BOOT**, run the command again, and press **RESET** when it is done.
- After flashing, esptool resets the chip ("Hard resetting via RTS pin"). The NCP then prints nothing readable on the
  port: it speaks the binary ZRHP protocol and only answers a host. That is expected.
- The merged image (and `erase-flash`) gives a **factory-new** NCP: any network stored on the chip is erased. To update
  the firmware later while _keeping_ the test network, write the parts without `zbnv` (as the web flasher does without
  erase; the blank `otadata` makes the new application in `ota_0` boot):

  ```bash
  esptool --chip esp32h2 --port "$PORT" write-flash 0x0 zrhp-ncp-h2-usj-0.1.0-bootloader.bin \
    0x8000 zrhp-ncp-h2-usj-0.1.0-partition-table.bin 0x9000 zrhp-ncp-h2-usj-0.1.0-otadata-blank.bin \
    0x10000 zrhp-ncp-h2-usj-0.1.0-app.bin
  ```

## 4. Install Zigbee2MQTT with the ZRHP adapter

Stock Zigbee2MQTT cannot run this NCP for two reasons:

1. its zigbee-herdsman has no ZRHP adapter, and
2. its settings schema allows only `deconz`, `zstack`, `zigate`, `ezsp`, `ember`, `zboss` and `zoh` for
   `serial.adapter`, so `adapter: zrhp` stops it at start with
   `serial/adapter must be equal to one of the allowed values`.

The Zigbee2MQTT fork [faronov/zigbee2mqtt, branch `zrhp`](https://github.com/faronov/zigbee2mqtt/tree/zrhp) fixes both:
Zigbee2MQTT 2.14.3 with `zrhp` in the schema and zigbee-herdsman pinned to a build of this fork. Its CI installs it on
Linux and Windows and runs it end to end on the NCP simulator. **Use it (option W) unless you need Docker.**

### Option W — the Zigbee2MQTT fork (Windows, Linux, macOS) — recommended

Needs [Node.js 22 or 24 LTS](https://nodejs.org/) and [Git](https://git-scm.com/) (Windows: "Git for Windows"). No C++
toolchain: the serial port module ships prebuilt binaries. On Windows use **Command Prompt** (`cmd`), or PowerShell after
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (PowerShell blocks the `pnpm.ps1` shim by default).

```bat
npm install -g pnpm@11.26.0
git clone -b zrhp https://github.com/faronov/zigbee2mqtt.git C:\z2m-zrhp
cd C:\z2m-zrhp
pnpm install --frozen-lockfile
pnpm run build
```

Put `configuration.yaml` (section 5) into a **new, empty** data directory, e.g. `C:\z2m-zrhp-data`, and start:

```bat
set ZIGBEE2MQTT_DATA=C:\z2m-zrhp-data
pnpm start
```

(PowerShell: `$env:ZIGBEE2MQTT_DATA="C:\z2m-zrhp-data"; pnpm start`; Linux/macOS:
`ZIGBEE2MQTT_DATA=~/z2m-zrhp-test/data pnpm start`.) The log shows `zigbee-herdsman` with a version ending in
`-zrhp.<n>` and `Coordinator firmware version: '{"meta":{…},"type":"zigbee-rs ZRHP"}'`.

Update later: `git pull`, then `pnpm install --frozen-lockfile` and `pnpm run build` again.

Do **not** run this from the folder of your production Zigbee2MQTT, and do not point it at its `data` folder.

### Already have stock Zigbee2MQTT built from source? (interim workaround)

If you replaced zigbee-herdsman in a stock checkout yourself (a pnpm override to this fork) and only the schema
complains, either

- **leave `adapter` out** of `serial` (keep `port`): this fork's zigbee-herdsman recognises the ESP32 DevKit's
  **USB** port (USB ID `303a:1001`, see "Auto-detection" below) and selects `zrhp` itself — stock Zigbee2MQTT accepts a
  configuration without `adapter`; or
- add `zrhp` to the schema with one line, run in the Zigbee2MQTT folder (`dist` is what runs, `lib` is the source):

  ```bat
  node -e "const fs=require('fs');for(const f of ['lib/util/settings.schema.json','dist/util/settings.schema.json'])if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\x22zoh\x22\s*\]/,'\x22zoh\x22, \x22zrhp\x22]'))"
  ```

  (works unchanged in cmd, PowerShell and bash; running it twice changes nothing.)

  A Zigbee2MQTT update overwrites the files: run it again after updating. The fork needs neither.

Stock Zigbee2MQTT has no setting that accepts an unknown adapter: the schema check runs before anything else, and
without the ZRHP zigbee-herdsman the adapter would not exist anyway.

### Auto-detection (`adapter` left out)

This fork's zigbee-herdsman selects `zrhp` for a port with USB ID `303a:1001` (Espressif USB-Serial-JTAG: the DevKit's
**USB** connector), on Linux also by the name `usb-Espressif_USB_JTAG_serial_debug_unit_…`. Limits:

- `303a:1001` is the same for **every** firmware on that connector of an ESP32-C3/C6/H2/S3 (it is built into the chip,
  the NCP firmware cannot change it). Any ESP32 board on its native USB port is taken for a ZRHP NCP; with several
  connected, set `port` (and better `adapter: zrhp`) explicitly.
- The DevKit's **UART** connector (CP2102N / CH343 USB-UART bridge, `10c4:ea60` / `1a86:55d3`) is never detected as
  ZRHP — the USB-Serial-JTAG images do not speak ZRHP there, and those bridge IDs are shared with Sonoff, SMLIGHT and
  other dongles (stock detection may even guess `zstack` for a bare CP2102N).
- The Thread Border Router board (UART, section 9) is not auto-detected: set `adapter: zrhp`, `baudrate` and
  `rtscts`.
- Explicit `adapter: zrhp` with `port` is always the most reliable setting (and needs the fork or the schema line
  above).

### Option A — Docker (Linux host)

```bash
docker build -t zigbee2mqtt-zrhp -f docker/zrhp-z2m/Dockerfile "https://github.com/faronov/zigbee-herdsman.git#zrhp"
```

This takes a few minutes (it builds the herdsman fork and Zigbee2MQTT 2.14.3; `--build-arg Z2M_REF=<tag>` and
`--build-arg HERDSMAN_REF=<branch or commit>` select other versions). Run it like the official image, with a **new,
empty** data directory:

```bash
mkdir -p ~/z2m-zrhp-test/data      # put configuration.yaml (section 5) here, with port: /dev/ttyZRHP
docker run -d --name z2m-zrhp --restart unless-stopped \
  -v ~/z2m-zrhp-test/data:/app/data \
  -v /run/udev:/run/udev:ro \
  --device /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00:/dev/ttyZRHP \
  -p 8081:8081 \
  -e TZ=Europe/Berlin \
  zigbee2mqtt-zrhp
docker logs -f z2m-zrhp
```

Docker Desktop on macOS/Windows cannot pass USB devices into containers: use option W there.

`--device` is resolved when the container starts. If the NCP resets while the container runs (RESET button, esptool),
its USB device is re-created and the container can lose it; Zigbee2MQTT then stops after about 20 s and
`--restart unless-stopped` starts it again with the new device.

### Option B — build script on a stock checkout (Linux, macOS; Windows with Git Bash or WSL)

Needs git, Node.js 22 or 24 (corepack is included) and a C/C++ toolchain for the serial port module:

```bash
git clone -b zrhp https://github.com/faronov/zigbee-herdsman.git
bash zigbee-herdsman/scripts/zrhp/build-z2m.sh ~/z2m-zrhp      # clones Zigbee2MQTT 2.14.3 into ~/z2m-zrhp and builds it
```

The script builds the herdsman fork, makes it _the_ zigbee-herdsman of that Zigbee2MQTT checkout (a pnpm override, also
for zigbee-herdsman-converters) and adds `zrhp` to the allowed `serial.adapter` values. Start Zigbee2MQTT with:

```bash
cd ~/z2m-zrhp
ZIGBEE2MQTT_DATA=~/z2m-zrhp-test/data node index.js
```

### Check the NCP before starting Zigbee2MQTT

All builds contain a small read-only probe (stop Zigbee2MQTT first, only one program can use the port):

```bash
cd C:\z2m-zrhp && node scripts/zrhp-probe.js COM7                                              # option W (Windows)
cd ~/z2m-zrhp && node .zrhp/probe.js "$PORT"                                                    # option B
docker run --rm --device "$PORT":/dev/ttyZRHP zigbee2mqtt-zrhp node .zrhp/probe.js /dev/ttyZRHP   # option A
```

Expected: `ZRHP session OK: protocol 1.0, firmware …, chip 1` (chip 1 = ESP32-H2, 2 = ESP32-C6), the NCP's IEEE address
and `transport USB-Serial-JTAG`.

## 5. `configuration.yaml` of the test instance

```yaml
version: 5
homeassistant:
    enabled: false # keep the test devices out of your Home Assistant
frontend:
    enabled: true
    port: 8081 # not your production frontend port
mqtt:
    base_topic: zigbee2mqtt-zrhp # not your production base topic
    server: mqtt://localhost:1883
    # user: …
    # password: …
serial:
    port: /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00 # Windows: COM7; Docker: /dev/ttyZRHP
    adapter: zrhp # needs the Zigbee2MQTT fork (or the schema line of section 4); may be left out, see "Auto-detection"
    # baudrate / rtscts: not needed over USB-Serial-JTAG (ignored)
advanced:
    channel: 20 # a channel your production network does NOT use
    network_key: GENERATE # never your production key
    pan_id: GENERATE
    ext_pan_id: GENERATE
    log_level: debug
    log_output: [console, file]
```

Zigbee2MQTT replaces the three `GENERATE` values with real ones on the first start. The log then shows (with
`log_level: debug`):

```
zh:zrhp:api: ZRHP session ready: NCP fw …, cookie 0x…, network_state 0 (new)
zh:zrhp: Formed network: PAN 0x…, channel 20
zh:zrhp: Started reset: <product> fw …, USB-Serial-JTAG, … APS in flight
Zigbee2MQTT started!
```

`reset` means "new network formed" and appears on the first start only; every later start must say `Started resumed`.

Optional tuning in `data/zrhp_config.json` (defaults shown; normally not needed):

```json
{"resumeBudgetMs": 20000, "connectTimeoutMs": 5000, "confirmTimeoutMs": 40000, "hardResetOnFailure": true}
```

## 6. What to test

Please go through what you can and note for each step: time, what you did, what you expected, what happened.

1. **Start**: the first start forms the network (`Started reset`). Stop and start Zigbee2MQTT: `Started resumed`, same
   PAN ID and channel; _Settings → About_ shows the coordinator type `zigbee-rs ZRHP`.
2. **Pairing**: _Permit join (All)_, then pair 2–5 spare devices, ideally
   - a mains-powered router (smart plug or bulb),
   - a battery sensor (temperature/humidity, door/window or motion),
   - a battery button or remote.

   For each: does the interview finish, are the exposes right, do reports arrive, can you control it?
3. **Pairing through a router**: with the plug/bulb in the network, pair a sensor next to the router and far from the
   DevKit.
4. **Groups and bindings**: put two lights/plugs into a group and switch the group; bind a remote to a light.
5. **Zigbee2MQTT restart** while the devices run: everything continues without re-pairing.
6. **NCP reboot while Zigbee2MQTT runs**: press the DevKit's **RESET** button (or unplug and replug its USB cable within
   a few seconds). Expected in the log: `NCP session lost; holding requests` then `NCP session resumed`, without a
   Zigbee2MQTT restart, and the devices keep working. (Option A: see the `--device` note in section 4.)
7. **Backup**: stop Zigbee2MQTT (it writes the coordinator backup on every stop) and check that
   `data/coordinator_backup.json` contains `"zigbee_rs"` under `stack_specific`.
8. **Restore onto a factory-new NCP** (the important one): with Zigbee2MQTT stopped, `erase-flash` and flash the merged
   image again (section 3; web flasher: with "Erase the whole chip first"), then start Zigbee2MQTT with the same `data` directory. Expected: `Started restored`, and
   the devices keep working **without re-pairing** (sleepy sensors may take a minute or a button press).
9. **Network map**: the coordinator's links to its direct neighbours and children should be shown (with LQI).
10. **Channel change** (do it last): stop Zigbee2MQTT, change `advanced.channel` to another free channel (e.g. 20 → 25),
    start again. Expected in the log: `NCP announced the move to channel 25` and about 10 s later
    `NCP radio on channel 25`; mains-powered devices follow at once, sleepy ones after their next wake-up (or a button
    press). Note which devices did not follow.
11. _(optional)_ **Green Power** devices (Philips Hue Tap, Friends of Hue switches, FlowerX GP): permit join, put the
    device into commissioning, check that Zigbee2MQTT creates it and sees the button presses.
12. _(optional)_ **The C6 DevKit**: repeat steps 1, 2, 6 and 8 with the C6 image.

### Known limitations of this test build

- Use release `ncp-v0.1.0` or newer. Older test images (CI artifacts of the branch `ncp-release-artifacts`) cannot
  change the channel (the adapter refuses with an explicit error), show no coordinator links on the network map and
  keep no coordinator group memberships.
- No transmit power setting yet (`transmit_power` is ignored by the NCP).
- No Touchlink / inter-PAN.
- Install codes and Green Power are implemented in the adapter but untested on hardware.

## 7. What to send back

Zip and send (it is a throw-away test network; **never send files of your production instance**):

- the logs: `data/log/<date>/log.log` of every session (`log_level: debug`), or `docker logs z2m-zrhp > z2m.log 2>&1`;
- `data/coordinator_backup.json`, `data/zrhp_store.jsonl`, `data/database.db`, `data/configuration.yaml`;
- the probe output (`node scripts/zrhp-probe.js …` or `node .zrhp/probe.js …`, Zigbee2MQTT stopped) before and after
  the tests;
- the NCP release you flashed (e.g. `ncp-v0.1.0`), the flasher's or esptool's output (it shows the chip revision, e.g.
  `Chip is ESP32-H2 (revision v0.1)`), the DevKit model;
- `ls -l /dev/serial/by-id/` (Linux), the OS, the install option (W, A or B) and the `zigbee-herdsman` version from the
  log;
- your notes per test step and the device models.

## 8. Rolling back

Your production setup is untouched as long as you followed the safety rules: it keeps its own coordinator, `data`
directory and container. To finish the test:

1. Stop and remove the test instance: `docker rm -f z2m-zrhp` (option A), or stop `pnpm start` / `node index.js`
   (Ctrl+C, options W and B) and delete `C:\z2m-zrhp` and `C:\z2m-zrhp-data`.
2. Factory-reset the test devices and pair them back to your production Zigbee2MQTT.
3. Optionally wipe the DevKit: `esptool --chip esp32h2 --port "$PORT" erase-flash` (any other firmware can be flashed
   afterwards).
4. If anything of the production instance was changed by mistake, stop it and put back the `data` directory you copied
   at the start.

## 9. Secondary: Espressif Thread Border Router board (UART)

On the Espressif Thread Border Router / Zigbee Gateway board the ESP32-H2 is not on USB: it is wired to the ESP32-S3
over UART (921 600 baud, RTS/CTS on the reserved 0 Ω links R19/R20). A desktop Zigbee2MQTT reaches it only through the
S3 running a USB bridge (zigbee-rs-hub's `tbr-bridge`), so this is for people who already have that bridge; the DevKit
test does not need it.

- Image: `zrhp-ncp-h2-br` (features `esp32h2,transport-uart,thread-br-h2,rtscts-reserved-lines`), flashed through the
  board's **H2** USB-C port: `esptool --chip esp32h2 --port <H2 port> write-flash 0x0 zrhp-ncp-h2-br-0.1.0-merged.bin`.
- Zigbee2MQTT with the S3 bridge's port:

  ```yaml
  serial:
    port: /dev/serial/by-id/<S3 bridge port>
    adapter: zrhp
    baudrate: 921600
    rtscts: false   # the bridge's USB side has no flow control; the bridge itself runs RTS/CTS towards the H2
  ```

- A plain USB-UART adapter wired to the H2's UART0 with RTS/CTS: `baudrate: 921600`, `rtscts: true`. Without flow
  control: `baudrate: 460800`, `rtscts: false` (the adapter also falls back to 460 800 by itself when the configured rate
  gets no answer at all). DTR/RTS of such a bridge may be wired to EN/BOOT: the adapter's hard reset uses the same
  sequence as esptool.
