import {
  Adapter, createBluetooth, GattCharacteristic, GattServer
} from "node-ble";
import { Logger, LoggerWithoutCallSite } from "tslog";

import { Packet, parseIncomingPacket } from "./protocol";
import { buf2hexstr, delay, makeLongUuid } from "./util";

export interface EventEmitter {
  emit(eventName: string, ...args: any[]): unknown;

  on(eventName: string, handler: (...args: any[]) => unknown): this;
  once(eventName: string, handler: (...args: any[]) => unknown): this;
  off(eventName: string, handler: (...args: any[]) => unknown): this;
}

/**
 * Events and corresponding payload arguments
 */
export interface EventTree {
  data: [packet: Packet];
  liveupdate: [weightValue: number];
  measurement: [weightValue: number];
  timeout: [];
}

export type EventName = keyof EventTree;

/**
 * Instance for communicating with the Renpho Scale.
 */
export class RenphoScale {
  protected readonly logger = new Logger({
    name: RenphoScale.name,
    displayFunctionName: false,
    displayFilePath: "hidden",
  });
  protected listeners: Record<EventName, Array<(...args: any[]) => unknown>> = {
    liveupdate: [],
    measurement: [],
    data: [],
    timeout: [],
  };

  /**
   * Whether to log a lot or not
   */
  protected verbose: boolean;

  /**
   * Has a timer ID as value if clock is ticking
   */
  timeoutHandle?: any;

  /**
   * The GATT characterstic (= communication channel) for sending commands.
   */
  public eventChar?: GattCharacteristic;

  /**
   * Factory function for connecting to a scale.
   *
   * @param btAdapter node-ble bluetooth adapter isntance
   * @param macAddress address of the BLE scale to be connected to
   * @param opts optional configuration
   * @returns an instance to communicate with
   */
  static async connect(
    btAdapter: Adapter,
    macAddress: string,
    opts: { verbose?: boolean } = {}
  ) {
    const logger = new LoggerWithoutCallSite({
      name: "connect()",
      displayFunctionName: false,
      displayFilePath: "hidden",
    });
    if (opts.verbose) logger.info(`Waiting for connection to ${macAddress}`);
    const device = await btAdapter.waitDevice(macAddress);
    await device.connect();
    if (opts.verbose) logger.info(`Connected!`);
    //  TODO we can get stuck here!, need another timeout
    const gatt = await device.gatt();
    return new RenphoScale(gatt, opts);
  }

  /**
   *
   * @param gatt node-ble GATT server to infer services and characteristics from.
   * @param opts optional configuration
   */
  constructor(public gatt: GattServer, opts: { verbose?: boolean } = {}) {
    this.verbose = opts?.verbose ?? false;
  }

  /**
   * Translates the magic number representing a scale type (lbs, kgs, ...) into a string
   */
  protected static getScaleType(magicNumber: number): string {
    // TODO fill this
    const SCALE_TYPES: Record<number, string> = { 21: "kg" };
    return SCALE_TYPES[magicNumber] ?? "unknown";
  }

  /**
   * The list of listeners registered for an event
   */
  protected getListeners(eventName: string) {
    const REGISTERED_LISTENERS = [
      "liveupdate",
      "measurement",
      "data",
      "timeout",
    ];
    if (!REGISTERED_LISTENERS.includes(eventName))
      throw new Error(`Invalid event: ${eventName}`);
    return this.listeners[eventName as EventName];
  }

  /**
   *
   * Emits an event with the given payload.
   */
  protected emit(eventName: EventName, ...args: any[]): this {
    this.getListeners(eventName).forEach((fn: any) => fn(...args));
    return this;
  }

  /**
   * Registers an event listener.
   */
  on(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (handler) this.getListeners(eventName).push(handler);
    return this;
  }

  /**
   * Registers an event listener to be run only once.
   */
  once(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    if (!handler) return this;

    const wrappedHandler = (...args: any[]) => {
      this.off(eventName, wrappedHandler);
      return handler(...args);
    };
    this.on(eventName, wrappedHandler);
    return this;
  }

  /**
   * De-registers an event listener if supplied or all listeners for the event otherwise.
   */
  off(eventName: EventName, handler?: (...args: any[]) => unknown): this {
    const listeners = this.getListeners(eventName);
    if (handler) {
      const index = listeners.findIndex((fn) => fn === handler);
      if (index >= 0) listeners.splice(index, 1);
    } else {
      listeners.splice(0, listeners.length);
    }
    return this;
  }

  /**
   * Sends a command packet to the characterstic.
   */
  protected async sendCommand(char: GattCharacteristic, buf: Buffer) {
    if (this.verbose)
      this.logger
        .getChildLogger({
          name: "SEND 👉",
        })
        .silly(buf2hexstr(buf));
    await char.writeValue(buf);
  }

  /**
   * Processes an incoming packet and causes events to be fired.
   */
  protected async handlePacket(outChar: GattCharacteristic, p: Packet) {
    if (this.verbose)
      this.logger
        .getChildLogger({
          name: "RECV 📨",
        })
        .silly(buf2hexstr(p.data));

    this.emit("data", p);

    switch (p.packetId) {
      case 0x12:
        if (this.verbose) this.logger.debug(`✅ Received handshake packet 1/2`);
        // ????
        const magicBytesForFirstPacket = [
          0x13, 0x09, 0x15, 0x01, 0x10, 0x00, 0x00, 0x00, 0x42,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForFirstPacket));
        return;
      case 0x14:
        if (this.verbose) this.logger.debug(`✅ Received handshake packet 2/2`);
        // turn on bluetooth indicator?
        const magicBytesForSecondPacket = [
          0x20, 0x08, 0x15, 0x09, 0x0b, 0xac, 0x29, 0x26,
        ];
        await this.sendCommand(outChar, Buffer.from(magicBytesForSecondPacket));
        return;
      case 0x10:
        const flag = p.data[5];
        if (flag === 0) {
          this.emit("liveupdate", p.weightValue);
        } else if (flag === 1) {
          if (this.verbose)
            this.logger.debug(`✅ Received completed measurement packet`);
          // send stop packet
          await this.sendCommand(
            outChar,
            Buffer.from([0x1f, 0x05, 0x15, 0x10, 0x49])
          );
          this.emit("measurement", p.weightValue);
        }
        return;
      default:
        this.logger.warn("Unknown packet", p);
    }
  }

  /**
   * Starts the BLE listening process and an accompanying timeout.
   *
   * The `timeout` event will be fired after no message was received for `timeoutSecs` seconds.
   */
  async startListening(timeoutSecs = 10) {
    if (this.eventChar) return;

    this.logger.info(`Listening... (timeout after ${timeoutSecs} seconds}`);

    const svc = await this.gatt.getPrimaryService(makeLongUuid("ffe0"));
    const eventChar = await svc.getCharacteristic(makeLongUuid("ffe1"));
    const commandChar = await svc.getCharacteristic(makeLongUuid("ffe3"));

    let didTimeout = false;
    const handleValueChange = (buf: Buffer) => {
      if (didTimeout) return;
      this.handlePacket(commandChar, parseIncomingPacket(buf)).catch((err) =>
        this.logger.warn("Error while handling packet", err.toString())
      );
    };

    const handleTimeout = () => {
      this.logger.warn(`timeout after (${timeoutSecs}) seconds`);
      didTimeout = true;
      this.emit("timeout");
      eventChar.off("valuechanged", handleValueChange);
      this.destroy();
    };
    const resetTimer = () => {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
      this.timeoutHandle = setTimeout(handleTimeout, timeoutSecs * 1000);
    };

    eventChar.on("valuechanged", handleValueChange);

    await eventChar.startNotifications();
    this.eventChar = eventChar;
    resetTimer();

    this.on("data", () => {
      resetTimer();
    });
  }

  /**
   * Stops listening and clears resources.
   */
  async destroy() {
    try {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = undefined;
      }
      await this.stopListening();
    } catch (err: any) {
      this.logger.debug(
        `Error during destroy(), but that's fine (${err.toString()})}`
      );
    }
  }

  /**
   * Stops listenining for BLE notifications.
   */
  protected async stopListening() {
    if (!this.eventChar) return;

    await this.eventChar.stopNotifications();
    this.eventChar = undefined;
  }
}

export const runMessageLoop = async (
  mac: string,
  once?: boolean,
  onConnect?: (scale: RenphoScale) => unknown
) => {
  const logger = new Logger({
    name: "main()",
    displayFunctionName: false,
    displayFilePath: "hidden",
  });

  const { bluetooth, destroy: destroyBluetooth } = createBluetooth();
  let destroyScaleSession: ((...args: any[]) => unknown) | undefined =
    undefined;

  try {
    const adapter = await bluetooth.defaultAdapter();

    const connectAndHandle = async () => {
      const scale = await RenphoScale.connect(adapter, mac, {
        verbose: false,
      });
      let raiseFlag: () => unknown;
      scale
        .on("timeout", () => {
          if (raiseFlag) raiseFlag();
        })
        .on("measurement", () => {
          if (raiseFlag) raiseFlag();
        });

      onConnect?.(scale);

      await scale.startListening(10);

      // this resolves as soon as raiseFlag() is called
      await new Promise<void>((resolve) => {
        raiseFlag = resolve;
      });

      // destructor to be called from somewhere else
      return () => {
        scale.destroy();
      };
    };

    // TODO DBusError: Operation already in progress can spam the console
    while (true) {
      try {
        destroyScaleSession = await connectAndHandle();
        if (once) break;
      } catch (err: any) {
        logger.warn(err.toString());
      }
      logger.info("Next iteration!");
      await delay(1);
    }

    // if we get to here, `once` is set and we're done
  } finally {
    logger.info("Destroying bluetooth connection");
    if (destroyScaleSession) destroyScaleSession();
    destroyBluetooth();
  }
};
