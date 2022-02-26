import { createBluetooth, GattCharacteristic, GattServer } from "node-ble";
import { Logger } from "tslog";

import { buf2hexstr } from "./util";

const logger = new Logger({
  name: "gatt",
  displayFunctionName: false,
  displayFilePath: "hidden",
});

export const printServices = async (gatt: GattServer) => {
  for (const svcUuid of (await gatt.services()).sort()) {
    const svc = await gatt.getPrimaryService(svcUuid);
    logger.info(`SERVICE      ${svcUuid}`);
    for (const charUuid of (await svc.characteristics()).sort()) {
      const char = await svc.getCharacteristic(charUuid);
      const flags = (await char.getFlags()).sort();
      logger.info(`CHAR         ${charUuid} [${flags.join(", ")}]`);
    }
  }
};

export const communicateWithGATT = async (
  deviceMac: string,
  onReady: (gatt: GattServer) => unknown
) => {
  deviceMac = deviceMac.toUpperCase();

  const { bluetooth, destroy } = createBluetooth();
  try {
    const adapter = await bluetooth.defaultAdapter();
    logger.info("Adapter found");
    logger.debug(await adapter.toString());

    const discovering = await adapter.isDiscovering();
    if (!discovering) await adapter.startDiscovery();
    logger.info("Discovery started");

    logger.info(`Waiting for device ${deviceMac}`);
    const device = await adapter.waitDevice(deviceMac);

    logger.info("Connecting...");
    await device.connect();
    logger.info("Connected!");

    const gatt = await device.gatt();

    await printServices(gatt);

    await onReady(gatt);

    logger.info("Everything is awesome!");
  } catch (err) {
    logger.error("ERROR", err);
    process.exit();
  } finally {
    logger.warn("Destroying Bluetooth session");
    destroy();
  }
};

export const writeToUuid = async (
  label: string,
  char: GattCharacteristic,
  data: Buffer
) => {
  logger.getChildLogger({ name: `${label} 👉` }).debug(buf2hexstr(data));
  await char.writeValue(data);
};
