declare module "qrcode-terminal" {
  const qrcode: { generate(text: string, opts: { small: boolean }, callback: (qr: string) => void): void };
  export default qrcode;
}
