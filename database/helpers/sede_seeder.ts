// database/helpers/sede_seeder.ts
//
// Multi-sede — los seeders que siembran datos por sede exigen la sede de
// forma explícita (variable de entorno SEED_SEDE; `node ace db:seed` no admite
// flags por seeder) y nunca escriben en la sede 2 (Bogotá: su arranque real
// no lleva datos sembrados). Lo normal es la sede de pruebas:
//
//   SEED_SEDE=3 node ace db:seed --files database/seeders/24_turnos_rtms_seeder.ts
//
// Se llama al INICIO de run(), antes de cualquier escritura: sin SEED_SEDE o
// con SEED_SEDE=2 el seeder lanza error sin tocar la BD.

export const SEDE_PROHIBIDA_SEEDERS = 2

export function sedeDeSeeder(seeder: string): number {
  const crudo = process.env.SEED_SEDE
  const v = Number(crudo)
  if (crudo === undefined || crudo === '' || !Number.isInteger(v) || v <= 0) {
    throw new Error(
      `[${seeder}] Falta SEED_SEDE=<id> (lo normal: SEED_SEDE=3, PRUEBAS QA). No se escribió nada.`
    )
  }
  if (v === SEDE_PROHIBIDA_SEEDERS) {
    throw new Error(
      `[${seeder}] SEED_SEDE=2 (Bogotá) está prohibida para datos sembrados. No se escribió nada.`
    )
  }
  return v
}
