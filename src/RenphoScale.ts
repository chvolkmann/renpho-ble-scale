import { Bluetooth, createBluetooth, GattServer } from "node-ble";
import { Logger, LoggerWithoutCallSite } from "tslog";

import { communicateWithGATT, writeToUuid } from "./gatt";
import { Packet, parseIncomingPacket } from "./protocol";
import { buf2hexstr, makeLongUuid } from "./util";

export interface EventEmitter {
  emit(eventName: string, ...args: any[]): unknown

  on(eventName: string, handler: (...args: any[]) => unknown): this
  off(eventName: string, handler: (...args: any[]) => unknown): this
}

export interface EventTree {
  liveupdate: [weightValue: number]
  measurement: [weightValue: number]
}

export type EventName = keyof EventTree

export class RenphoScale {
  protected listeners: Record<EventName, Array<(...args: any[]) => unknown>> = {
    'liveupdate': [],
    'measurement': []
  }
  protected readonly logger = new Logger({
    name: RenphoScale.name,
    displayFunctionName: false,
    displayFilePath: "hidden",
  })

  protected verbose: boolean

  constructor(public gatt: GattServer, opts: { verbose?: boolean } = {}) {
    this.verbose = opts?.verbose ?? true
  }

  static async connect(macAddress: string, opts: { bluetooth: Bluetooth, verbose?: boolean } = {}) {
    const logger = new LoggerWithoutCallSite({ name: 'connect()' })
    let bluetooth = opts.bluetooth
    let destroy = undefined
    if (!bluetooth) { let { bluetooth, destroy } = createBluetooth() }


    macAddress = macAddress.toUpperCase()

    // TODO Destroy
    const adapter = await bluetooth.defaultAdapter();
    if (opts.verbose)
      logger.info("Adapter found", await adapter.toString());
    if (opts.verbose)
      logger.info(`Waiting for device advertisement from ${macAddress}`);
    const device = await adapter.waitDevice(macAddress);
    if (opts.verbose)
      logger.info(`Connecting to ${macAddress}`);
    await device.connect();
    if (opts.verbose)
      logger.info(`Connected!`);
    const gatt = await device.gatt();
    return new RenphoScale(gatt, opts)
  }

  protected static getScaleType(magicNumber: number) {
    // TODO fill this
    const SCALE_TYPES: Record<number, string> = { 21: 'kg' }
    return SCALE_TYPES[magicNumber] ?? 'unknown'
  }

  private getListeners(eventName: string) {
    if (!['liveupdate', 'measurement'].includes(eventName))
      throw new Error(`Invalid event: ${eventName}`);
    return this.listeners[eventName as 'liveupdate' | 'measurement']
  }

  emit(eventName: EventName, ...args: any[]): this {
    this.getListeners(eventName).forEach((fn: any) => fn(...args))
    return this
  }

  on(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (handler)
      this.getListeners(eventName).push(handler)
    return this
  }

  off(eventName: EventName, handler?: (...args: any[]) => unknown) {
    const listeners = this.getListeners(eventName)
    if (handler) {
      const index = listeners.findIndex(fn => fn === handler)
      if (index >= 0)
        listeners.splice(index, 1)
    } else {
      listeners.splice(0, listeners.length)
    }
  }

  async takeMeasurement() {
    this.logger.info('Starting measurement...')


    const svc = await this.gatt.getPrimaryService(makeLongUuid("ffe0"));
    const eventChar = await svc.getCharacteristic(makeLongUuid("ffe1"));
    const commandChar = await svc.getCharacteristic(makeLongUuid("ffe3"));

    const sendCommand = async (buf: Buffer) => {
      if (this.verbose)
        this.logger.getChildLogger({
          name: 'SEND 👉'
        }).debug(buf2hexstr(buf))
      await commandChar.writeValue(buf)
    }

    const handlePacket = async (p: Packet) => {
      if (this.verbose)
        this.logger.getChildLogger({
          name: 'RECV 📨'
        }).debug(buf2hexstr(p.data))

      switch (p.packetId) {
        case 0x12:
          this.logger.debug(`✅ Packet Handshake 1/2`);
          // ????
          const magicBytesForFirstPacket = [0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42]
          await sendCommand(Buffer.from(magicBytesForFirstPacket))
          return;
        case 0x14:
          this.logger.debug(`✅ Packet Handshake 2/2`);
          // turn on bluetooth indicator?
          const magicBytesForSecondPacket = [0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26]
          await sendCommand(Buffer.from(magicBytesForSecondPacket))
          return;
        case 0x10:
          const flag = p.data[5]
          if (flag === 0) {
            this.emit('liveupdate', p.weightValue)
          }
          else if (flag === 1) {
            this.logger.debug(`✅ Packet Measurement Complete`);
            this.emit('measurement', p.weightValue)
            // send stop packet
            await writeToUuid(
              "ffe3",
              commandChar,
              Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49])
            );

            await eventChar.stopNotifications()
            this.logger.info('MEASUREMENT COMPLETED')
          }
          return;
        default:
          return;
      }
    }

    eventChar.on('valuechanged', (buf) => { handlePacket(parseIncomingPacket(buf)).catch(err => this.logger.error(err)) })

    await eventChar.startNotifications()
  }
}

(async () => {
  const r = RenphoScale.connect("A4:C1:38:D9:67:6A", { verbose: true })
})()