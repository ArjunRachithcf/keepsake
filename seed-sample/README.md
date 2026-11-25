# Sample sheet (fictional)

`gift-list.csv` is an invented "Gift List" tab in the shape of the household's sheet (ADR 0005), for the import's tests
and for trying the import wizard: the names are made up (they match the test household in
`apps/server/test/helpers.ts`, plus one nobody has, to map). It has the cases the importer must handle: a BOM, quoted
cells with commas, quotes and a line break, Reserved and Bought rows, a formula in a cell, a `javascript:` link, a price
that is not one, an occasion with no celebration, empty rows. Real sheets never go into git (`/seed/` is ignored).
