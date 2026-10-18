const HONORIFIC = /^(?:panią|pani|pana|panu|pan|herrn|herr|frau|mrs|mr|ms|miss|dr|mme|mlle|sig\.ra|sig|sra|sr|m)\.?\s+/iu;
const POLISH_GENITIVE = /(?:^|[\s,.])(?:u|dla|od)\s+(?:(?:pani|panią|pana|panu|pan)\s+)?\p{Lu}[\p{L}'-]+/u;

/** Remove leading honorifics ("Pani", "Herr", "Dr.") so the given name and surname split cleanly. */
export function stripHonorific(name: string): string {
  let out = name.trim().replace(/\s+/g, " ");
  for (;;) {
    const m = HONORIFIC.exec(out);
    if (!m || m[0].length >= out.length) break;
    out = out.slice(m[0].length).trim();
  }
  return out;
}

export function splitCustomerName(name: string): { fullName: string; givenName: string; surname: string } {
  const clean = stripHonorific(name);
  const fullName = clean || name.trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  return { fullName, givenName: parts[0] ?? "", surname: parts.slice(1).join(" ") };
}

/**
 * Polish names after u, dla and od are often in the genitive ("u Pani Anny Nowak"), so the name may need checking.
 */
export function needsNameCheck(text: string): boolean {
  return POLISH_GENITIVE.test(text);
}
