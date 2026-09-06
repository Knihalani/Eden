/** IANA charset names. Codec; non-identity meanings live in synth. */
export const CHARSET_TAB = `big5
euc-jp
euc-kr
gb18030
gb2312
gbk
ibm437
iso-2022-jp
iso-8859-1
iso-8859-10
iso-8859-13
iso-8859-14
iso-8859-15
iso-8859-16
iso-8859-2
iso-8859-3
iso-8859-4
iso-8859-5
iso-8859-6
iso-8859-7
iso-8859-8
iso-8859-9
koi8-r
koi8-u
macintosh
shift_jis
us-ascii
utf-8
windows-1250
windows-1251
windows-1252
windows-1253
windows-1254
windows-1255
windows-1256
windows-1257
windows-1258`;

export function charsetNames(): string[] {
  return CHARSET_TAB.split("\n").filter(Boolean);
}
