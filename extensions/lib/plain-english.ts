export function applySimpleEnglish(text: string): string {
  return text
    .replace(/\b[Ll]everag(?:e|ed|es|ing)\b/g, "Use")
    .replace(/\b[Uu]tiliz(?:e|ed|es|ing)\b/g, "Use")
    .replace(/\bin order to\b/gi, "to")
    .replace(/\bprior to\b/gi, "before")
    .replace(/\b[Ee]nsur(?:e|ed|es|ing)\b/g, "Make sure")
    .replace(/\b[Ss]hould\b/g, "must")
    .replace(/\b[Mm]ay\b/g, "can")
    .replace(/\b[Mm]ight\b/g, "can")
    .replace(/\b[Cc]ould\b/g, "can")
    .replace(/\b[Ww]ould\b/g, "will")
    .replace(/\b[Ss]eamlessly\b/g, "")
    .replace(/\b[Rr]obust\b/g, "")
    .replace(/\b[Cc]omprehensive\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
