import { createBluetooth, GattCharacteristic, GattServer } from "node-ble";
import { Logger } from "tslog";

import { communicateWithGATT, writeToUuid } from "./gatt";
import { Packet, packet2str, parseIncomingPacket } from "./protocol";
import { buf2hex, delay, makeLongUuid } from "./util";

const DEVICE_MAC_ADDR = "A4:C1:38:D9:67:6A";
const logger = new Logger({
  displayFunctionName: false,
  displayFilePath: "hidden",
});

communicateWithGATT(DEVICE_MAC_ADDR, async (gatt) => {
  const svc = await gatt.getPrimaryService(makeLongUuid("ffe0"));

  const ffe1 = await svc.getCharacteristic(makeLongUuid("ffe1"));
  const ffe2 = await svc.getCharacteristic(makeLongUuid("ffe2"));
  const ffe3 = await svc.getCharacteristic(makeLongUuid("ffe3"));
  const ffe4 = await svc.getCharacteristic(makeLongUuid("ffe4"));
  const ffe5 = await svc.getCharacteristic(makeLongUuid("ffe5"));

  ffe2.on("valuechanged", (buf) => {
    logger.getChildLogger({ name: "ffe2 📨" }).debug(buf2hex(buf));
  });

  ffe1.on("valuechanged", (buf) =>
    handlePacket(parseIncomingPacket(buf)).catch(logger.warn)
  );
  const handlePacket = async (p: Packet) => {
    logger.getChildLogger({ name: "ffe1 📨" }).debug(packet2str(p));

    switch (p.packetId) {
      case 0x12:
        logger.debug(`✅ Packet 1`);
        // ????
        await writeToUuid(
          "ffe3",
          ffe3,
          Buffer.from([0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42])
        );
        return;
      case 0x14:
        logger.debug(`✅ Packet 2`);
        // turn on bluetooth lamp
        await writeToUuid(
          "ffe3",
          ffe3,
          Buffer.from([0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26])
        );
        return;
      case 0x10:
        if (p.data[5] === 1) {
          logger.debug(`✅ Packet 3`);
          // send stop
          await writeToUuid(
            "ffe3",
            ffe3,
            Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49])
          );
        }
        return;
      default:
        return;
    }
  };

  logger.info("Starting listeners...");
  await ffe1.startNotifications();
  await ffe2.startNotifications();

  // logger.info('Waiting for packet 1...')
  // let resp = await nextPacket(ffe1)
  // logger.debug(`--> ✅`, packet2str(resp))
  // await writeToUuid('ffe3', ffe3, Buffer.from([0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42]))

  // logger.info('Waiting for packet 2...')
  // resp = await nextPacket(ffe1)
  // logger.debug(`--> ✅`, packet2str(resp))
  // await writeToUuid('ffe3', ffe3, Buffer.from([0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26]))

  // logger.info('Waiting for packet 3...')
  // resp = await waitForPacket(ffe3, p => p.packetId === 0x10 && p.data[5] === 1)
  // logger.debug(`--> ✅`, packet2str(resp))
  // await writeToUuid('ffe3', ffe3, Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49]))

  await delay(60);
});
