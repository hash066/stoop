/**
 * A title as it reads mid-sentence: "Wooden drop-side crib" -> "wooden drop-side crib", while brand
 * and model titles ("ACME Roadster jogging stroller", "Hybrid bike (XL)") keep their case. Plain title
 * case from a model ("Porch Bench") isn't a brand, so it reads in lower case.
 */
export const inSentence = (title: string): string =>
  /^[A-Z][a-z]+(?: [A-Z][a-z]+)+$/.test(title) ? title.toLowerCase() : /[A-Z]/.test(title.slice(1)) ? title : title.charAt(0).toLowerCase() + title.slice(1);
