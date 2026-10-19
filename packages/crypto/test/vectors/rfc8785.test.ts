// Source: RFC 8785 (JCS) test data, cyberphone/json-canonicalization testdata/
//   https://raw.githubusercontent.com/cyberphone/json-canonicalization/master/testdata/input/<name>.json
//   https://raw.githubusercontent.com/cyberphone/json-canonicalization/master/testdata/output/<name>.json
// Strings are JSON.stringify copies of the fetched files (trailing newline stripped).
// Not yet covered: RFC 8785 Appendix B IEEE-hex table (rfc-editor.org unreachable from sandbox).
import { describe, expect, it } from "vitest";

import { canonicalize } from "../../src/index.ts";

const JCS_VECTORS = [
  {
    name: "arrays",
    input: '[\n  56,\n  {\n    "d": true,\n    "10": null,\n    "1": [ ]\n  }\n]',
    output: '[56,{"1":[],"10":null,"d":true}]',
  },
  {
    name: "french",
    input:
      '{\n  "peach": "This sorting order",\n  "péché": "is wrong according to French",\n  "pêche": "but canonicalization MUST",\n  "sin":   "ignore locale"\n}',
    output:
      '{"peach":"This sorting order","péché":"is wrong according to French","pêche":"but canonicalization MUST","sin":"ignore locale"}',
  },
  {
    name: "structures",
    input:
      '{\n  "1": {"f": {"f": "hi","F": 5} ,"\\n": 56.0},\n  "10": { },\n  "": "empty",\n  "a": { },\n  "111": [ {"e": "yes","E": "no" } ],\n  "A": { }\n}',
    output:
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
  },
  {
    name: "unicode",
    input: '{\n  "Unnormalized Unicode":"A\\u030a"\n}',
    output: '{"Unnormalized Unicode":"Å"}',
  },
  {
    name: "values",
    input:
      '{\n  "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],\n  "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",\n  "literals": [null, true, false]\n}',
    output:
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  },
  {
    name: "weird",
    input:
      '{\n  "\\u20ac": "Euro Sign",\n  "\\r": "Carriage Return",\n  "\\u000a": "Newline",\n  "1": "One",\n  "\\u0080": "Control\\u007f",\n  "\\ud83d\\ude02": "Smiley",\n  "\\u00f6": "Latin Small Letter O With Diaeresis",\n  "\\ufb33": "Hebrew Letter Dalet With Dagesh",\n  "</script>": "Browser Challenge"\n}',
    output:
      '{"\\n":"Newline","\\r":"Carriage Return","1":"One","</script>":"Browser Challenge","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😂":"Smiley","דּ":"Hebrew Letter Dalet With Dagesh"}',
  },
] as const;

describe("RFC 8785 JCS cyberphone vectors", () => {
  it.each(JCS_VECTORS)("canonicalizes $name.json to the expected output", ({ input, output }) => {
    expect(canonicalize(JSON.parse(input))).toBe(output);
  });
});
