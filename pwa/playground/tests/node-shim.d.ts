// The two node APIs the byte checks use, declared locally.
//
// The tool's tsconfig sets "types": [] the way the baseline's does, so there is
// no @types/node in the packet and none is added for this. Only what is
// actually called is declared, so the shim cannot quietly widen.

declare module "node:fs" {
  export function readFileSync(path: string | URL): Uint8Array;
  export function readFileSync(path: string | URL, encoding: "utf8"): string;
}

declare module "node:crypto" {
  interface Hash {
    update(data: Uint8Array | string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: "sha256"): Hash;
}
