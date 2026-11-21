# Тестирование Zigbee2MQTT на NCP zigbee-rs (ZRHP)

[English version](zrhp-z2m-testing.md)

Инструкция для тех, у кого уже работает Zigbee2MQTT и кто хочет попробовать сетевой сопроцессор (NCP)
[zigbee-rs](https://github.com/faronov/zigbee-rs) в роли координатора Zigbee. Знать zigbee-rs или Rust не нужно: вы
прошиваете готовый образ на Espressif DevKit, запускаете **отдельный, только тестовый** Zigbee2MQTT, собранный с этим
форком herdsman (`adapter: zrhp`), сопрягаете несколько запасных устройств и присылаете логи.

Статус: экспериментальный. Прошивка NCP и этот адаптер проходят тесты протокола и симулятора (в том числе
Zigbee2MQTT целиком против симулятора NCP в CI), а сам NCP уже формировал сети и обслуживал подключённое устройство на
реальных ESP32-H2/C6, но **Zigbee2MQTT на настоящем NCP ещё не запускался** — для этого и нужен этот тест (гейт H11
[спецификации ZRHP](https://github.com/faronov/zigbee-rs/blob/master/docs/book/src/advanced/host-protocol.md)).

> ### ⚠️ Сначала безопасность
>
> - **Сделайте копию** рабочей папки `data` Zigbee2MQTT перед началом (скопируйте папку целиком в надёжное место).
> - **Никогда** не подключайте тестовый Zigbee2MQTT к рабочей папке `data`, `configuration.yaml`, ключу сети, PAN ID
>   или `coordinator_backup.json`. Если NCP восстановит ваш рабочий бэкап, он станет _вторым координатором вашей
>   настоящей сети_ с бо́льшими счётчиками кадров, и устройства начнут отвергать кадры вашего настоящего координатора
>   как повторы. Для ключа сети, PAN ID и extended PAN ID используйте `GENERATE`, как показано ниже.
> - Дайте тестовому экземпляру свой базовый MQTT-топик и порт веб-интерфейса (`zigbee2mqtt-zrhp` и 8081 ниже) и не
>   подключайте его к рабочему Home Assistant.
> - Сопрягайте только **запасные** устройства. Устройство, сопряжённое с тестовой сетью, уходит из рабочей; чтобы
>   вернуть его, сделайте ему сброс к заводским настройкам и снова сопрягите с рабочим Zigbee2MQTT.

## 1. Железо

| Приоритет        | Плата                                                       | Образ прошивки    | Какой порт использовать                                                    |
| ---------------- | ----------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- |
| **1 (основной)** | ESP32-H2 DevKit (ESP32-H2-DevKitM-1 или похожий, флеш 4 МБ) | `zrhp-ncp-h2-usj` | разъём USB-C с подписью **USB**                                            |
| 2                | ESP32-C6 DevKit (ESP32-C6-DevKitC-1, флеш 4 или 8 МБ)       | `zrhp-ncp-c6-usj` | разъём USB-C с подписью **USB**                                            |
| дополнительно    | плата Espressif Thread Border Router / Zigbee Gateway       | `zrhp-ncp-h2-br`  | см. [раздел 9](#9-дополнительно-плата-espressif-thread-border-router-uart) |

Сначала проверяйте **H2**: это чип только для 802.15.4, как и основная цель zigbee-rs. У C6 есть ещё Wi-Fi, который эта
прошивка не использует.

На обоих DevKit два разъёма USB-C:

- **USB** — встроенный в чип порт _USB-Serial-JTAG_. **Используйте его.** По нему NCP говорит по ZRHP, и через него же
  esptool прошивает и сбрасывает чип.
- **UART** — мост USB-UART (CP2102N или CH343) на UART0 чипа. Этой прошивкой не используется (по нему идут только
  сообщения ROM при загрузке). Его не подключайте.

Через USB-Serial-JTAG скорость и управление потоком игнорируются, их настраивать не нужно.

### Имена последовательных портов

| ОС      | Порт **USB** появляется как                                                                                                            | Порт UART (не используется)                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Linux   | `/dev/ttyACM0`, а лучше `/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00` (число в имени — MAC чипа) | `/dev/ttyUSB0`, `usb-Silicon_Labs_CP2102N…` или `usb-1a86_USB_Single_Serial…` |
| macOS   | `/dev/cu.usbmodemNNNN` (используйте имя `cu.`, а не `tty.`)                                                                            | `/dev/cu.usbserial-…`, `/dev/cu.wchusbserial…`                                |
| Windows | `COMn` — «USB Serial Device (COMn)» в Диспетчере устройств                                                                             | «Silicon Labs CP210x … (COMn)», «USB-Enhanced-SERIAL CH343 (COMn)»            |

В Linux проверьте `ls -l /dev/serial/by-id/` и всегда используйте путь `by-id`: после сброса NCP USB-устройство
переподключается и может получить другой номер `ttyACM`. Вашему пользователю нужен доступ к порту (группа `dialout` в
Debian/Ubuntu, `uucp` в Arch).

## 2. Где взять прошивку NCP

**Проще всего — веб-прошивальщик:** <https://faronov.github.io/zigbee-rs/flasher/> (Chrome или Edge на компьютере;
Firefox и Safari не умеют Web Serial).

1. Выберите плату: **ESP32-H2 DevKit: ZRHP NCP** (основной вариант) или **ESP32-C6 DevKit: ZRHP NCP**.
2. Выберите версию — по умолчанию отмечена последняя стабильная (`recommended`). На странице видны дата, коммит,
   `build_id`, ссылка на описание изменений и SHA-256 каждого файла.
3. Галочка **«Erase the whole chip first»**:
   - **первая установка** (на плате другая прошивка или вы хотите начать с нуля) — **поставьте**: чип будет полностью
     стёрт;
   - **обновление** NCP, на котором уже есть тестовая сеть, — **не ставьте**: прошивальщик запишет только загрузчик,
     таблицу разделов, пустой `otadata` и приложение, раздел `zbnv` (сеть, ключи, устройства) останется. В следующем
     окне ESP Web Tools («Erase device?») галочку тоже не ставьте.
4. Подключите разъём **USB** DevKit (не UART), нажмите **Install** и выберите порт («USB JTAG/serial debug unit»).
   Если порт не находится: зажмите **BOOT**, нажмите и отпустите **RESET**, отпустите **BOOT**, повторите.

Прошивальщик сам проверяет, что чип совпадает с выбранной платой. Все образы берутся из GitHub-релизов
<https://github.com/faronov/zigbee-rs/releases> (теги `ncp-v…`), а не из артефактов CI, поэтому у всех тестирующих
одна и та же сборка. В логах и отчётах указывайте версию (например `ncp-v0.1.0`).

**Без браузера (esptool).** На странице релиза те же файлы: `zrhp-ncp-<плата>-<версия>-merged.bin` (полный образ
4 МБ, пишется по адресу `0x0` и стирает сеть), отдельные части и `SHA256SUMS`; команды esptool — в описании релиза.
Берите esptool v5 (`write-flash`; в v4 — `write_flash`) и файлы одного релиза, не смешивая с образами из старых
инструкций.

## 3. Прошивка через esptool

Нужно только без веб-прошивальщика. Скачайте файлы одного релиза (например `ncp-v0.1.0`) с
<https://github.com/faronov/zigbee-rs/releases> и проверьте их: `sha256sum -c SHA256SUMS --ignore-missing` (macOS:
`shasum -a 256 -c SHA256SUMS --ignore-missing`).

Установите esptool (команды ниже для v5; в esptool v4 они называются `esptool.py … write_flash` / `erase_flash`):

```bash
python3 -m pip install --upgrade esptool
```

Подключите к компьютеру порт **USB** платы и выполните (со своим портом):

```bash
# ESP32-H2 (основной)
PORT=/dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00
esptool --chip esp32h2 --port "$PORT" erase-flash
esptool --chip esp32h2 --port "$PORT" write-flash 0x0 zrhp-ncp-h2-usj-0.1.0-merged.bin

# ESP32-C6 (второй)
esptool --chip esp32c6 --port "$PORT" erase-flash
esptool --chip esp32c6 --port "$PORT" write-flash 0x0 zrhp-ncp-c6-usj-0.1.0-merged.bin
```

macOS: `PORT=/dev/cu.usbmodemNNNN`; Windows: `--port COM5`.

- esptool сам переводит чип в режим загрузки и обратно через USB-Serial-JTAG. Если подключиться не удаётся: зажмите
  **BOOT**, нажмите и отпустите **RESET**, отпустите **BOOT**, повторите команду, а по окончании нажмите **RESET**.
- После прошивки esptool перезагружает чип («Hard resetting via RTS pin»). Дальше NCP ничего читаемого в порт не пишет:
  он говорит по двоичному протоколу ZRHP и отвечает только хосту. Так и должно быть.
- Полный образ (и `erase-flash`) даёт NCP **как с завода**: сохранённая на чипе сеть стирается. Чтобы позже обновить
  прошивку и _сохранить_ тестовую сеть, пишите части без `zbnv` (как веб-прошивальщик без стирания; пустой `otadata`
  нужен, чтобы загрузилось новое приложение в `ota_0`):

  ```bash
  esptool --chip esp32h2 --port "$PORT" write-flash 0x0 zrhp-ncp-h2-usj-0.1.0-bootloader.bin \
    0x8000 zrhp-ncp-h2-usj-0.1.0-partition-table.bin 0x9000 zrhp-ncp-h2-usj-0.1.0-otadata-blank.bin \
    0x10000 zrhp-ncp-h2-usj-0.1.0-app.bin
  ```

## 4. Установка Zigbee2MQTT с адаптером ZRHP

Обычный Zigbee2MQTT не может работать с этим NCP по двум причинам:

1. в его zigbee-herdsman нет адаптера ZRHP;
2. его схема настроек разрешает для `serial.adapter` только `deconz`, `zstack`, `zigate`, `ezsp`, `ember`, `zboss` и
   `zoh`, поэтому с `adapter: zrhp` он останавливается при запуске с ошибкой
   `serial/adapter must be equal to one of the allowed values`.

Форк Zigbee2MQTT [faronov/zigbee2mqtt, ветка `zrhp`](https://github.com/faronov/zigbee2mqtt/tree/zrhp) исправляет
оба пункта: это Zigbee2MQTT 2.14.3 с `zrhp` в схеме и с zigbee-herdsman, закреплённым на сборке этого форка. Его CI
устанавливает его на Linux и Windows и прогоняет целиком на симуляторе NCP. **Используйте его (способ W), если вам не
нужен Docker.**

### Способ W — форк Zigbee2MQTT (Windows, Linux, macOS) — рекомендуется

Нужны [Node.js 22 или 24 LTS](https://nodejs.org/) и [Git](https://git-scm.com/) (в Windows — «Git for Windows»).
Компилятор C++ не нужен: модуль последовательного порта поставляется собранным. В Windows используйте **Командную
строку** (`cmd`) или PowerShell после `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (по умолчанию PowerShell
блокирует обёртку `pnpm.ps1`).

```bat
npm install -g pnpm@11.26.0
git clone -b zrhp https://github.com/faronov/zigbee2mqtt.git C:\z2m-zrhp
cd C:\z2m-zrhp
pnpm install --frozen-lockfile
pnpm run build
```

Положите `configuration.yaml` (раздел 5) в **новую, пустую** папку данных, например `C:\z2m-zrhp-data`, и запустите:

```bat
set ZIGBEE2MQTT_DATA=C:\z2m-zrhp-data
pnpm start
```

(PowerShell: `$env:ZIGBEE2MQTT_DATA="C:\z2m-zrhp-data"; pnpm start`; Linux/macOS:
`ZIGBEE2MQTT_DATA=~/z2m-zrhp-test/data pnpm start`.) В логе версия `zigbee-herdsman` заканчивается на `-zrhp.<n>`, и
есть `Coordinator firmware version: '{"meta":{…},"type":"zigbee-rs ZRHP"}'`.

Обновление: `git pull`, затем снова `pnpm install --frozen-lockfile` и `pnpm run build`.

**Не** запускайте это из папки рабочего Zigbee2MQTT и не указывайте его папку `data`.

### Уже есть обычный Zigbee2MQTT, собранный из исходников? (временный обход)

Если вы сами заменили zigbee-herdsman в обычной копии (override в pnpm на этот форк) и ругается только схема, то либо

- **уберите `adapter`** из `serial` (оставьте `port`): zigbee-herdsman из этого форка узнаёт порт **USB** у ESP32 DevKit
  (USB ID `303a:1001`, см. «Автоопределение» ниже) и сам выбирает `zrhp`, а обычный Zigbee2MQTT принимает конфигурацию
  без `adapter`; либо
- добавьте `zrhp` в схему одной строкой, выполнив её в папке Zigbee2MQTT (`dist` — то, что запускается, `lib` —
  исходники):

  ```bat
  node -e "const fs=require('fs');for(const f of ['lib/util/settings.schema.json','dist/util/settings.schema.json'])if(fs.existsSync(f))fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/\x22zoh\x22\s*\]/,'\x22zoh\x22, \x22zrhp\x22]'))"
  ```

  (работает без изменений в cmd, PowerShell и bash; повторный запуск ничего не меняет.)

  Обновление Zigbee2MQTT перезаписывает эти файлы: после обновления выполните строку снова. Форку не нужно ни то, ни
  другое.

В обычном Zigbee2MQTT нет настройки, которая разрешила бы неизвестный адаптер: проверка схемы идёт раньше всего
остального, а без zigbee-herdsman с ZRHP самого адаптера всё равно не было бы.

### Автоопределение (`adapter` не указан)

zigbee-herdsman из этого форка выбирает `zrhp` для порта с USB ID `303a:1001` (Espressif USB-Serial-JTAG: разъём **USB**
на DevKit), в Linux ещё и по имени `usb-Espressif_USB_JTAG_serial_debug_unit_…`. Ограничения:

- `303a:1001` одинаков для **любой** прошивки на этом разъёме ESP32-C3/C6/H2/S3 (он встроен в чип, прошивка NCP не может
  его изменить). Любая плата ESP32 на родном USB-порту будет принята за NCP ZRHP; если подключено несколько, укажите
  `port` (а лучше и `adapter: zrhp`) явно.
- Разъём **UART** на DevKit (мост USB-UART CP2102N / CH343, `10c4:ea60` / `1a86:55d3`) как ZRHP не определяется никогда:
  образы для USB-Serial-JTAG там не говорят на ZRHP, а эти ID мостов общие с Sonoff, SMLIGHT и другими донглами
  (обычное автоопределение может даже принять голый CP2102N за `zstack`).
- Плата Thread Border Router (UART, раздел 9) не определяется автоматически: укажите `adapter: zrhp`, `baudrate` и
  `rtscts`.
- Явные `adapter: zrhp` и `port` — всегда самый надёжный вариант (нужен форк или строка для схемы выше).

### Способ A — Docker (хост на Linux)

```bash
docker build -t zigbee2mqtt-zrhp -f docker/zrhp-z2m/Dockerfile "https://github.com/faronov/zigbee-herdsman.git#zrhp"
```

Это занимает несколько минут (собираются форк herdsman и Zigbee2MQTT 2.14.3; другие версии выбираются через
`--build-arg Z2M_REF=<тег>` и `--build-arg HERDSMAN_REF=<ветка или коммит>`). Запускайте как официальный образ, с
**новой, пустой** папкой данных:

```bash
mkdir -p ~/z2m-zrhp-test/data      # сюда положите configuration.yaml (раздел 5), с port: /dev/ttyZRHP
docker run -d --name z2m-zrhp --restart unless-stopped \
  -v ~/z2m-zrhp-test/data:/app/data \
  -v /run/udev:/run/udev:ro \
  --device /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00:/dev/ttyZRHP \
  -p 8081:8081 \
  -e TZ=Europe/Berlin \
  zigbee2mqtt-zrhp
docker logs -f z2m-zrhp
```

Docker Desktop на macOS/Windows не умеет пробрасывать USB-устройства в контейнеры: там используйте способ W.

`--device` определяется при старте контейнера. Если NCP перезагрузится, пока контейнер работает (кнопка RESET,
esptool), его USB-устройство пересоздаётся и контейнер может его потерять; тогда Zigbee2MQTT остановится примерно через
20 с, и `--restart unless-stopped` запустит его снова уже с новым устройством.

### Способ B — скрипт сборки на обычной копии (Linux, macOS; Windows через Git Bash или WSL)

Нужны git, Node.js 22 или 24 (corepack входит в комплект) и компилятор C/C++ для модуля последовательного порта:

```bash
git clone -b zrhp https://github.com/faronov/zigbee-herdsman.git
bash zigbee-herdsman/scripts/zrhp/build-z2m.sh ~/z2m-zrhp      # клонирует Zigbee2MQTT 2.14.3 в ~/z2m-zrhp и собирает его
```

Скрипт собирает форк herdsman, делает его _тем самым_ zigbee-herdsman в этой копии Zigbee2MQTT (override в pnpm, в том
числе для zigbee-herdsman-converters) и добавляет `zrhp` в допустимые значения `serial.adapter`. Запуск
Zigbee2MQTT:

```bash
cd ~/z2m-zrhp
ZIGBEE2MQTT_DATA=~/z2m-zrhp-test/data node index.js
```

### Проверка NCP перед запуском Zigbee2MQTT

Во всех сборках есть маленькая проверка только на чтение (сначала остановите Zigbee2MQTT — порт может занимать только
одна программа):

```bash
cd C:\z2m-zrhp && node scripts/zrhp-probe.js COM7                                              # способ W (Windows)
cd ~/z2m-zrhp && node .zrhp/probe.js "$PORT"                                                    # способ B
docker run --rm --device "$PORT":/dev/ttyZRHP zigbee2mqtt-zrhp node .zrhp/probe.js /dev/ttyZRHP   # способ A
```

Ожидается: `ZRHP session OK: protocol 1.0, firmware …, chip 1` (chip 1 = ESP32-H2, 2 = ESP32-C6), IEEE-адрес NCP и
`transport USB-Serial-JTAG`.

## 5. `configuration.yaml` тестового экземпляра

```yaml
version: 5
homeassistant:
    enabled: false # не пускать тестовые устройства в ваш Home Assistant
frontend:
    enabled: true
    port: 8081 # не порт рабочего веб-интерфейса
mqtt:
    base_topic: zigbee2mqtt-zrhp # не рабочий базовый топик
    server: mqtt://localhost:1883
    # user: …
    # password: …
serial:
    port: /dev/serial/by-id/usb-Espressif_USB_JTAG_serial_debug_unit_XX:XX:XX:XX:XX:XX-if00 # Windows: COM7; Docker: /dev/ttyZRHP
    adapter: zrhp # нужен форк Zigbee2MQTT (или строка для схемы из раздела 4); можно не указывать, см. «Автоопределение»
    # baudrate / rtscts: через USB-Serial-JTAG не нужны (игнорируются)
advanced:
    channel: 20 # канал, которого НЕТ в рабочей сети
    network_key: GENERATE # никогда не рабочий ключ
    pan_id: GENERATE
    ext_pan_id: GENERATE
    log_level: debug
    log_output: [console, file]
```

При первом запуске Zigbee2MQTT заменит три значения `GENERATE` настоящими. В логе (с `log_level: debug`) будет:

```
zh:zrhp:api: ZRHP session ready: NCP fw …, cookie 0x…, network_state 0 (new)
zh:zrhp: Formed network: PAN 0x…, channel 20
zh:zrhp: Started reset: <product> fw …, USB-Serial-JTAG, … APS in flight
Zigbee2MQTT started!
```

`reset` означает «сформирована новая сеть» и бывает только при первом запуске; при всех следующих должно быть
`Started resumed`.

Необязательная настройка в `data/zrhp_config.json` (показаны значения по умолчанию; обычно не нужно):

```json
{"resumeBudgetMs": 20000, "connectTimeoutMs": 5000, "confirmTimeoutMs": 40000, "hardResetOnFailure": true}
```

## 6. Что проверить

Пройдите, что получится, и для каждого шага запишите: время, что делали, что ожидали, что произошло.

1. **Запуск**: первый запуск формирует сеть (`Started reset`). Остановите и запустите Zigbee2MQTT: `Started resumed`,
   тот же PAN ID и канал; в _Settings → About_ тип координатора `zigbee-rs ZRHP`.
2. **Сопряжение**: _Permit join (All)_, затем сопрягите 2–5 запасных устройств, лучше всего
   - роутер с питанием от сети (умная розетка или лампа),
   - датчик на батарейке (температура/влажность, дверь/окно или движение),
   - кнопку или пульт на батарейке.

   Для каждого: доходит ли interview до конца, правильные ли exposes, приходят ли отчёты, можно ли управлять?
3. **Сопряжение через роутер**: когда розетка/лампа уже в сети, сопрягите датчик рядом с роутером и далеко от DevKit.
4. **Группы и привязки**: добавьте две лампы/розетки в группу и переключите группу; привяжите пульт к лампе.
5. **Перезапуск Zigbee2MQTT** при работающих устройствах: всё продолжает работать без повторного сопряжения.
6. **Перезагрузка NCP при работающем Zigbee2MQTT**: нажмите **RESET** на DevKit (или выдерните и снова вставьте его
   USB-кабель за несколько секунд). В логе ожидается `NCP session lost; holding requests`, затем
   `NCP session resumed`, без перезапуска Zigbee2MQTT, и устройства продолжают работать. (Способ A: см. замечание про
   `--device` в разделе 4.)
7. **Бэкап**: остановите Zigbee2MQTT (он пишет бэкап координатора при каждой остановке) и проверьте, что в
   `data/coordinator_backup.json` есть `"zigbee_rs"` внутри `stack_specific`.
8. **Восстановление на чистый NCP** (самое важное): при остановленном Zigbee2MQTT сделайте `erase-flash` и снова
   прошейте полный образ (раздел 3; в веб-прошивальщике — с «Erase the whole chip first»), затем запустите Zigbee2MQTT с той же папкой `data`. Ожидается: `Started restored`,
   и устройства продолжают работать **без повторного сопряжения** (спящим датчикам может понадобиться минута или нажатие
   кнопки).
9. **Карта сети**: должны быть видны связи координатора с его прямыми соседями и детьми (с LQI).
10. **Смена канала** (делайте последней): остановите Zigbee2MQTT, поменяйте `advanced.channel` на другой свободный канал
    (например 20 → 25), запустите снова. Ожидается в логе: `NCP announced the move to channel 25` и примерно через 10 с
    `NCP radio on channel 25`; устройства с питанием от сети переходят сразу, спящие — после следующего пробуждения (или
    нажатия кнопки). Запишите, какие устройства не перешли.
11. _(необязательно)_ **Устройства Green Power** (Philips Hue Tap, выключатели Friends of Hue, FlowerX GP): разрешите
    сопряжение, переведите устройство в режим commissioning, проверьте, что Zigbee2MQTT его создаёт и видит нажатия.
12. _(необязательно)_ **DevKit на C6**: повторите шаги 1, 2, 6 и 8 с образом для C6.

### Известные ограничения этой тестовой сборки

- Берите релиз `ncp-v0.1.0` или новее. Старые тестовые образы (артефакты CI ветки `ncp-release-artifacts`) не умеют
  менять канал (адаптер откажет с понятной ошибкой), не показывают связи координатора на карте сети и не хранят группы
  координатора.
- Мощность передатчика пока не настраивается (`transmit_power` NCP игнорирует).
- Нет Touchlink / inter-PAN.
- Install codes и Green Power в адаптере реализованы, но на железе не проверены.

## 7. Что прислать

Заархивируйте и пришлите (это одноразовая тестовая сеть; **никогда не присылайте файлы рабочего экземпляра**):

- логи: `data/log/<дата>/log.log` каждой сессии (`log_level: debug`) или `docker logs z2m-zrhp > z2m.log 2>&1`;
- `data/coordinator_backup.json`, `data/zrhp_store.jsonl`, `data/database.db`, `data/configuration.yaml`;
- вывод проверки (`node scripts/zrhp-probe.js …` или `node .zrhp/probe.js …`, Zigbee2MQTT остановлен) до и после
  тестов;
- версию прошитого релиза NCP (например `ncp-v0.1.0`), вывод прошивальщика или esptool (в нём ревизия чипа, например
  `Chip is ESP32-H2 (revision v0.1)`), модель DevKit;
- `ls -l /dev/serial/by-id/` (Linux), ОС, способ установки (W, A или B), версию `zigbee-herdsman` из лога;
- свои заметки по каждому шагу и модели устройств.

## 8. Откат

Пока вы соблюдали правила безопасности, рабочая установка не тронута: у неё свой координатор, своя папка `data` и свой
контейнер. Чтобы закончить тест:

1. Остановите и удалите тестовый экземпляр: `docker rm -f z2m-zrhp` (способ A) или остановите `pnpm start` /
   `node index.js` (Ctrl+C, способы W и B) и удалите папки `C:\z2m-zrhp` и `C:\z2m-zrhp-data`.
2. Сбросьте тестовые устройства к заводским настройкам и сопрягите их обратно с рабочим Zigbee2MQTT.
3. По желанию очистите DevKit: `esptool --chip esp32h2 --port "$PORT" erase-flash` (после этого можно прошить любую
   другую прошивку).
4. Если что-то в рабочем экземпляре было случайно изменено, остановите его и верните папку `data`, скопированную в
   начале.

## 9. Дополнительно: плата Espressif Thread Border Router (UART)

На плате Espressif Thread Border Router / Zigbee Gateway ESP32-H2 подключён не к USB, а к ESP32-S3 по UART (921 600 бод,
RTS/CTS на резервных перемычках 0 Ом R19/R20). Zigbee2MQTT на компьютере достаёт до него только через S3 с прошивкой
USB-моста (`tbr-bridge` из zigbee-rs-hub), поэтому это для тех, у кого такой мост уже есть; для теста с DevKit он не
нужен.

- Образ: `zrhp-ncp-h2-br` (фичи `esp32h2,transport-uart,thread-br-h2,rtscts-reserved-lines`), прошивается через
  USB-C порт **H2** на плате: `esptool --chip esp32h2 --port <порт H2> write-flash 0x0 zrhp-ncp-h2-br-0.1.0-merged.bin`.
- Zigbee2MQTT с портом моста S3:

  ```yaml
  serial:
    port: /dev/serial/by-id/<порт моста S3>
    adapter: zrhp
    baudrate: 921600
    rtscts: false   # на USB-стороне моста управления потоком нет; сам мост держит RTS/CTS в сторону H2
  ```

- Обычный адаптер USB-UART, подключённый к UART0 H2 с RTS/CTS: `baudrate: 921600`, `rtscts: true`. Без управления
  потоком: `baudrate: 460800`, `rtscts: false` (адаптер и сам переходит на 460 800, если на заданной скорости ответа нет
  совсем). DTR/RTS такого моста могут быть подключены к EN/BOOT: аппаратный сброс адаптера использует ту же
  последовательность, что и esptool.
