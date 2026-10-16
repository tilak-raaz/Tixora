/** Where the end-to-end tests' API and helpers reach Postgres (the `make up` container by default). */
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://bmt:bmt@localhost:5432/bmt';
