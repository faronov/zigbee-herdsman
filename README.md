# zigbee-herdsman

[![npm](https://img.shields.io/npm/v/zigbee-herdsman)](https://www.npmjs.com/package/zigbee-herdsman)

zigbee-herdsman is an open source Zigbee gateway solution with Node.js JavaScript runtime back-end.

It was originally forked from zigbee-shepherd with the goal to refactor it to improve maintainability.

# This fork: ZRHP adapter for zigbee-rs NCPs (branch `zrhp`)

This fork ([faronov/zigbee-herdsman](https://github.com/faronov/zigbee-herdsman), branch `zrhp`) adds the adapter
`zrhp` for [zigbee-rs](https://github.com/faronov/zigbee-rs) network co-processors (ESP32-H2 / ESP32-C6) speaking the
ZRHP host protocol ([spec](https://github.com/faronov/zigbee-rs/blob/master/docs/book/src/advanced/host-protocol.md))
over USB-Serial-JTAG or UART. It is maintained here only; there is no upstream pull request.

- **Testing it with Zigbee2MQTT** (hardware, firmware download, flashing, Docker or local build, configuration, what to
  test, what to send back, rollback): **[docs/zrhp-z2m-testing.md](docs/zrhp-z2m-testing.md)** ([русская версия](docs/zrhp-z2m-testing.ru.md)).
- Zigbee2MQTT configuration: `serial: {adapter: zrhp, port: <the DevKit's USB port>}`; `baudrate` (default 921 600) and
  `rtscts` only matter on UART. Without `adapter`, a port with USB ID `303a:1001` (Espressif USB-Serial-JTAG, shared by
  all ESP32 firmwares on that port) is auto-detected as `zrhp`.
- Code: [`src/adapter/zrhp`](src/adapter/zrhp) (link layer, messages, records, OCB backup mapping, adapter),
  tests in [`test/adapter/zrhp`](test/adapter/zrhp) (shared vectors, ARQ traces, link faults, adapter against a
  scriptable NCP and against the Rust NCP simulator: `ZRHP_NCP_SIM=<path to ncp_sim> pnpm test`).
- Backups: `coordinator_backup.json` keeps `stack_specific.zigbee_rs` and the TCLK frame counter; unknown
  `stack_specific` sections and `metadata.internal` keys are passed through (`Models.Backup.stackSpecific`/`internal`).
- Zigbee2MQTT with this fork: the Zigbee2MQTT fork [faronov/zigbee2mqtt, branch `zrhp`](https://github.com/faronov/zigbee2mqtt/tree/zrhp)
  (`adapter: zrhp` in its settings schema; pins the `v*-zrhp.*` release tarball that CI publishes for every green push
  here), [`scripts/zrhp/build-z2m.sh`](scripts/zrhp/build-z2m.sh) (stock checkout) or
  [`docker/zrhp-z2m/Dockerfile`](docker/zrhp-z2m/Dockerfile); CI runs both end to end against the NCP simulator
  ([`.github/workflows/zrhp.yml`](.github/workflows/zrhp.yml)).

# API Documentation

For automatically generated API reference documentation, see: https://koenkk.github.io/zigbee-herdsman.

# Changelog

For complete release notes, including breaking changes, see: [CHANGELOG.md](./CHANGELOG.md)

# Related projects

## Zigbee2MQTT

[Zigbee2MQTT](https://github.com/Koenkk/zigbee2mqtt) is a Zigbee to MQTT gateway. It bridges events and allows you to control your Zigbee devices via MQTT. Allows you to use your Zigbee devices without the vendors or propritary and closed sources bridges or gateways. Zigbee2MQTT also keeps track of the state of the system and the capabilities of connected devices. It uses zigbee-herdsman and [zigbee-herdsman-converters](https://github.com/Koenkk/zigbee-herdsman-converters) as modules to handle low-level core Zigbee communication.

## ioBroker

[ioBroker](https://github.com/ioBroker) is an home automation integration platform that is focused on Building Automation, Smart Metering, Ambient Assisted Living, Process Automation, Visualization and Data Logging. It uses zigbee-herdsman for its Zigbee integration.
