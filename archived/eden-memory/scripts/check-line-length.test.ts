import { describe, expect, test } from "bun:test";
import { overlongLines } from "./check-line-length";

const WIDTH = 40;
const pad = (n: number) => "x".repeat(n);
const check = (text: string, path = "a.ts") => overlongLines(path, text, WIDTH);

describe("overlongLines", () => {
  test("a line at the width passes; one character more fails", () => {
    const fits = `const ${pad(WIDTH - 11)} = 1;`;
    expect(fits.length).toBe(WIDTH);
    expect(check(fits)).toEqual([]);
    expect(check(`const ${pad(WIDTH - 10)} = 1;`)).toEqual([{ line: 1, length: WIDTH + 1 }]);
  });

  test("reports 1-based line numbers", () => {
    expect(check(`a();\nb();\nconst ${pad(WIDTH)} = 1;\n`)).toEqual([{ line: 3, length: WIDTH + 11 }]);
  });

  test("comments must fit", () => {
    expect(check(`// ${pad(WIDTH)}`)).toHaveLength(1);
    expect(check(`/**\n * ${pad(WIDTH)}\n */\nf();`)).toEqual([{ line: 2, length: WIDTH + 3 }]);
  });

  test("a line may exceed the width only by its literals", () => {
    expect(check(`f("${pad(WIDTH)}");`)).toEqual([]);
    expect(check(`f(\`${pad(WIDTH)}\`);`)).toEqual([]);
    expect(check(`f(\`a\${b}${pad(WIDTH)}\`);`)).toEqual([]);
    expect(check(`const r = /${pad(WIDTH)}/i;`)).toEqual([]);
    expect(check(`test("${pad(WIDTH)}", async () => {});`)).toEqual([]);
  });

  test("the code around a literal still counts", () => {
    expect(check(`f("${pad(10)}", ${pad(WIDTH)});`)).toHaveLength(1);
  });

  test("the code inside a template's ${…} still counts", () => {
    expect(check(`f(\`a\${${pad(WIDTH)}}b\`);`)).toHaveLength(1);
    expect(check(`f(\`a\${g(\`${pad(WIDTH)}\`)}b\`);`)).toEqual([]);
  });

  test("a line inside a multi-line template is a literal", () => {
    expect(check(`const t = \`\n${pad(WIDTH * 2)}\n\`;`)).toEqual([]);
  });

  test("division is not mistaken for a regex", () => {
    expect(check(`const q = a / ${pad(WIDTH)} / b;`)).toHaveLength(1);
  });

  test("counts code points, not UTF-16 units", () => {
    expect(check(`// ${"😀".repeat(WIDTH - 3)}`)).toEqual([]);
  });

  test("parses TSX and JavaScript", () => {
    expect(check(`const e = <a b="${pad(WIDTH)}" />;`, "a.tsx")).toEqual([]);
    expect(check(`const r = /${pad(WIDTH)}/;`, "a.mjs")).toEqual([]);
  });
});
