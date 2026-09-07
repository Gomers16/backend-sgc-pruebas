import { BaseSeeder } from '@adonisjs/lucid/seeders'
import Cargo from '#models/cargo'

export default class CargoSeeder extends BaseSeeder {
  async run() {
    const cargos = [
      // 🏢 Direcciones
      { nombre: 'DIRECCION DE CALIDAD Y AUDITORÍA' },
      { nombre: 'DIRECCION ADMINISTRATIVA Y COMERCIAL' },

      // 👥 Áreas administrativas y gerenciales
      { nombre: 'GERENCIA' },
      { nombre: 'TALENTO HUMANO' },
      { nombre: 'CONTADOR' },
      { nombre: 'COORDINADOR DE DESARROLLO DE SOFTWARE' }, // ✅ NUEVO

      // 🎯 Líderes
      { nombre: 'LIDER DE SEDE' },
      { nombre: 'LIDER DE INFORMES' },
      { nombre: 'LIDER NACIONAL' },

      // 🤝 Comercial
      { nombre: 'ASESOR COMERCIAL' },
      { nombre: 'ASESOR CONVENIO' },

      // 👨‍💼 Servicio al cliente
      { nombre: 'ASESOR SERVICIO AL CLIENTE' },

      // 🔧 Técnico
      { nombre: 'INGENIERO' },
      { nombre: 'INSPECTOR' },
    ]

    // Filtra para cargos únicos por nombre antes de crearlos
    const uniqueCargos = Array.from(new Set(cargos.map((c) => c.nombre))).map((nombre) => ({
      nombre,
    }))

    await Cargo.createMany(uniqueCargos)
  }
}
