# renpho-ble-scale

Library for connecting to a [person weight scale from RENPHO](https://www.amazon.de/-/en/Bathroom-Bluetooth-Personal-Digital-Skeletal/dp/B077RXM292) over Bluetooth Low Energy (BLE).

## Installation
TODO

## Usage
```typescript
import { runMessageLoop } from "renpho-ble-scale";

// tries to connect to the MAC address and calls onConnect() when ready
runMessageLoop("A4:C1:38:AB:CD:EF", {
  // if set to true, returs after the first weight measurement
  once: false,

  // adjust to your needs, set to 'trace' to get everything
  loglevel: "info", 

  // will be called with a RenphoScale instance to communicate with
  onConnect: (scale) => {
    console.log("Connected!");

    // subscribe to some events
    // liveupdate is emitted roughly each second with the current weight
    // measurement is emitted after the display blinks and the weight value has converged
    scale
      .on("liveupdate", (val) => console.log(`[*] ${val.toFixed(2)}kg`))
      .on("measurement", (val) => console.log(`--> ${val.toFixed(2)}kg`));
  },
}).catch(console.error);
```