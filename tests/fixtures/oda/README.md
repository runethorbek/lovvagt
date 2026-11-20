# ODA fixtures

Real responses from Folketingets Åbne Data (ODA), recorded on 2026-11-19
(unless noted) and used by the ODA client tests (`tests/unit/oda-*.test.ts`),
the topic rule tests (`tests/unit/topics.test.ts`) and the ingest tests
(`tests/unit/ingest-*.test.ts`). Tests never call ODA; they serve these files
through a mocked `fetch`. The ingest step tests compose recorded rows into
responses (e.g. SagAktør rows with their `SagAktørRolle` row nested, as
`$expand=SagAktørRolle` returns them) without changing field values.

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

Recorded on 2026-11-20 for the topic rule tests (2024-25 bills L 141, L 31,
L 152, L 188 and L 210, Sag 69354, 99215, 101043, 101403 and 101688):

| File                      | Source query                                                   | Trimmed                                                                                                         |
| ------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `sag-<id>.json`           | `Sag` `<id>`                                                   | No                                                                                                              |
| `sagaktoer-<id>.json`     | `SagAktør`, `sagid eq <id>`                                    | No                                                                                                              |
| `emneordsag-<id>.json`    | `EmneordSag`, `sagid eq <id>`, `$expand=Emneord`               | No                                                                                                              |
| `aktoer-ministerier.json` | `Aktør`, `typeid eq 1` (175 rows over two pages of `$top=100`) | 6 rows: the role 6 ministries of the fixture bills (Aktør 2, 11, 204, 254, 20977, 20986); `odata.count` dropped |
