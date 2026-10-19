/**
 * A title as it reads mid-sentence: "Wooden drop-side crib" -> "wooden drop-side crib", while brand
 * and model titles ("ACME Roadster jogging stroller", "Hybrid bike (XL)") keep their case.
 */
export const inSentence = (title: string): string => (/[A-Z]/.test(title.slice(1)) ? title : title.charAt(0).toLowerCase() + title.slice(1));
