# ODA fixtures

Real responses from Folketingets Åbne Data (ODA), recorded on 2026-11-19 and
used by the ODA client tests (`tests/unit/oda-*.test.ts`). Tests never call
ODA; they serve these files through a mocked `fetch`.

The files are trimmed to keep them small. Field values are never changed:

| File                                                                                   | Source query                                                                        | Trimmed                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| `sag-paged-p1.json`                                                                    | `Sag`, `typeid eq 3 and periodeid eq 163`, `$inlinecount=allpages`                  | First 2 of 100 rows; `odata.nextLink` kept     |
| `sag-101687.json`                                                                      | `Sag` 101687 (L 211, 2024-25)                                                       | No                                             |
| `sag-101039.json`                                                                      | `Sag` 101039 (L 154, 2024-25)                                                       | No                                             |
| `sagaktoer-<id>.json`                                                                  | `SagAktør`, `sagid eq <id>`                                                         | No                                             |
| `emneordsag-<id>.json`                                                                 | `EmneordSag`, `sagid eq <id>`, `$expand=Emneord`                                    | No                                             |
| `sagstrin-<id>.json`                                                                   | `Sagstrin`, `sagid eq <id>`, `$expand=Sagstrinstype`                                | No                                             |
| `afstemning-<id>.json`                                                                 | `Afstemning`, `Sagstrin/sagid eq <id>` (none for 101687)                            | No                                             |
| `sagdokument-101687.json`                                                              | `SagDokument`, `sagid eq 101687`, `$expand=Dokument/Fil`                            | 3 of 17 rows (two `Forslagstekst`, one bilag)  |
| `sagdokument-101039.json`                                                              | `SagDokument`, `sagid eq 101039`, `$expand=Dokument/Fil`                            | 3 of 21 rows (two `Forslagstekst`, one answer) |
| `stemme-10204-p1.json`, `stemme-10204-p2.json`                                         | `Stemme`, `afstemningid eq 10204`: page 1 (with `odata.nextLink`) and the last page | First 3 of 100 and 2 of 79 rows                |
| `sagstrinstype.json`                                                                   | `Sagstrinstype`, first page                                                         | First 3 of 100 rows; `odata.nextLink` kept     |
| `aktoer-referenced.json`                                                               | `Aktør` 8, 11, 206 and 21041                                                        | `biografi` cut to its first 200 characters     |
| `emneord-33142.json`                                                                   | `Emneord` 33142                                                                     | No                                             |
| `periode-samling.json`                                                                 | `Periode`, `type eq 'samling'` from 2024-10-01                                      | No                                             |
| `sagaktoerrolle.json`, `sagdokumentrolle.json`, `stemmetype.json`, `dokumenttype.json` | Lookup tables                                                                       | No                                             |
