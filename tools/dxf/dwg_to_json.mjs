// AL DWG -> JSON. Setup: npm i @mlightcad/libredwg-web (run from this folder). Usage: node dwg_to_json.mjs in.dwg out.json
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web'
import fs from 'fs'
const lib = await LibreDwg.create(new URL('./node_modules/@mlightcad/libredwg-web/wasm/', import.meta.url).pathname)
const buf = fs.readFileSync(process.argv[2])
const dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG)
const db = lib.convert(dwg)
fs.writeFileSync(process.argv[3], JSON.stringify(db, null, 1))
console.log(Object.keys(db), db.entities?.length)
