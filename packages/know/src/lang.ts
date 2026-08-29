/** Compact English trigram prior. Not fastText; beats raw Latin-letter ratio on mixed CC. */

const EN = new Set(
  `the and ing ion tio ent nce ter ate ers hat her tha eth for thi wit his you was not but had are from have been were they this that with will would there their about would could should which after first also into more some such only other than then them these being under over also just like back well even most many those come made find long down day did get own see way may say she use two how its our out
the and ing`.match(/[a-z]{3}/g) || [],
);

for (const g of [
  "the","and","ing","ion","tio","ent","nce","ter","ate","ers","hat","her","tha","eth","for","thi","wit",
  "his","you","was","not","but","had","are","fro","hav","bee","wer","the","thi","tha","wit","wil","wou",
  "the","ere","ed ","in ","on ","at ","es ","of ","to ","en ","al ","an ","er ","re ","nd ","as ","is ",
]) {
  const x = g.replace(/ /g, "");
  if (x.length === 3) EN.add(x);
}

export function englishTrigram(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z]/g, "");
  if (t.length < 48) return false;
  let hit = 0;
  const n = t.length - 2;
  for (let i = 0; i < n; i++) {
    if (EN.has(t.slice(i, i + 3))) hit++;
  }
  return hit / n > 0.07;
}
