declare module "*.css";

// The package ships typings its "exports" map hides; it is API-compatible with better-sqlite3.
declare module "better-sqlite3-multiple-ciphers" {
  import Database from "better-sqlite3";
  export = Database;
}
