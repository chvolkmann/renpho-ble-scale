export const buf2hex = (buf: Buffer): string => buf.toString('hex').split('').map((c, i) => i !== 0 && i % 2 == 0 ? ' ' + c : c).join('')

export const delay = async (secs: number) => new Promise(resolve => setTimeout(resolve, secs * 1000))

export const makeLongUuid = (short: string): string => `0000${short}-0000-1000-8000-00805f9b34fb`

export const lpad = (num: string | number, len: number): string => num.toString().padStart(len, '0')
