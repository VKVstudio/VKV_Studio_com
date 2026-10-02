// jsdom has no bundled declarations. The test suite narrows this unknown
// export to its explicit JsdomCtor interface; no implicit any or new package.
declare module 'jsdom' {
  export const JSDOM: unknown;
}
