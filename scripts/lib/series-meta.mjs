// Chip class + display name per series view key — matches the CSS
// classes (.chip.f1, .chip.nascar, .chip.indy, .chip.moto, .chip.wec,
// .chip.wrc, .chip.formula-e) and existing chipText strings already used
// throughout index.html.
export const SERIES_META = {
  f1: { chip: 'f1', chipText: 'Formula 1' },
  'nascar-cup': { chip: 'nascar', chipText: 'NASCAR Cup' },
  'nascar-oreilly': { chip: 'nascar', chipText: "O'Reilly Series" },
  'nascar-truck': { chip: 'nascar', chipText: 'Truck Series' },
  arca: { chip: 'nascar', chipText: 'ARCA Menards' },
  indycar: { chip: 'indy', chipText: 'NTT IndyCar' },
  'indy-nxt': { chip: 'indy', chipText: 'Indy NXT' },
  motogp: { chip: 'moto', chipText: 'MotoGP' },
  wec: { chip: 'wec', chipText: 'WEC' },
  wrc: { chip: 'wrc', chipText: 'WRC' },
  'formula-e': { chip: 'formula-e', chipText: 'Formula E' },
};
