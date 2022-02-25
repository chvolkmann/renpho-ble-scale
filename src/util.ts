export const buf2hexstr = (buf: Buffer): string => buf.toString('hex').split('').map((c, i) => i !== 0 && i % 2 == 0 ? ' ' + c : c).join('')

export const delay = async (secs: number) => new Promise(resolve => setTimeout(resolve, secs * 1000))

export const makeLongUuid = (shortUuid: string): string => `0000${shortUuid}-0000-1000-8000-00805f9b34fb`

export const lpad = (num: string | number, len: number): string => num.toString().padStart(len, '0')

export const range = (num: string) => Array.from(Array(num))