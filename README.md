# 🍽️ Comedor UNAB · Sistema de Reservas & Francotirador (SaaS)

Sistema web con arquitectura **Frontend + Backend** listo para despliegue en **Railway (railway.app)**, diseñado con un estilo **minimalista profesional (sin efectos neón)**, control de usuarios con roles (**SuperAdmin** y **Estudiante**), generación de **código QR oficial** y motor automatizado de reservas a las **17:00:00 (5:00 PM)** con consumo ultra-bajo de memoria RAM (< 50 MB).

---

## 🚀 Despliegue en Railway (3 Pasos)

El proyecto incluye todos los archivos de configuración requeridos por Railway (`Dockerfile`, `package.json`, `railway.json`):

### Opción A: Despliegue vía GitHub (Recomendado)
1. Sube esta carpeta a tu repositorio de GitHub (ejemplo: `mi-comedor-unab`).
2. En tu cuenta de [Railway.app](https://railway.app), haz clic en **"New Project"** -> **"Deploy from GitHub repo"**.
3. Selecciona tu repositorio. Railway detectará automáticamente el `Dockerfile` optimizado y levantará la aplicación.

### Opción B: Despliegue vía Railway CLI
```bash
railway login
railway init
railway up
```

---

## 💻 Ejecución Local en Windows

Haz doble clic en:
👉 **[`iniciar_portal.bat`](file:///c:/Users/aange/OneDrive/Escritorio/comedor%20unab%20almuero/iniciar_portal.bat)**

El navegador se abrirá automáticamente en:
👉 **`http://localhost:3000`**

---

## 🔑 Credenciales Iniciales

### 1. Panel de SuperAdministrador:
* **Usuario:** `admin`
* **Contraseña:** `admin12345`

### 2. Panel de Alumno (Angelo):
* **Usuario:** `222.0113.028`
* **Contraseña:** `Dotamipasion12345`
* **Alumno:** `SERNA SIMEON, ANGELO THOMAS` (DNI: `76448557`)

*(En la pantalla de inicio de sesión hay dos botones de acceso rápido para ingresar con 1 clic a cualquiera de los dos roles).*

---

## 🌟 Funcionalidades por Rol

### 🛡️ Panel de SuperAdmin
1. **Gestión de Alumnos / Usuarios:**
   - Alta de nuevos alumnos con su código UNAB, contraseña, DNI y sede.
   - Activación o desactivación de cuentas.
   - Interruptor individual de auto-reserva (Francotirador 17:00).
   - Eliminación de usuarios.
2. **Francotirador Centralizado Masivo:**
   - Cuenta regresiva a las 17:00:00 sincronizada con hora de Lima.
   - Disparo masivo automático o forzado que reserva almuerzos para todos los alumnos activos en paralelo.
   - Terminal de registro de solicitudes en tiempo real.
3. **Auditoría Global de Reservas:**
   - Registro de todos los tickets generados por cualquier estudiante, con ID de reserva y fecha.
4. **Métricas del Servidor & Memoria RAM:**
   - Visualización del uso de RAM (RSS ~45MB, Heap ~8MB).
   - Monitoreo del contenedor en Railway y sesiones activas.

### 👤 Panel de Alumno
1. **Auto-Reserva 17:00:00 (Francotirador Personal):**
   - Configuración de comida preferida (`ALMUERZO`, `CENA`, `DESAYUNO`).
   - Cuenta regresiva milisegundo a milisegundo hasta las 17:00:00.
2. **Menú & Disponibilidad en Tiempo Real:**
   - Consulta de cupos libres y becarios.
   - Indicador visual claro cuando un plato está agotado (**"SIN PLATOS DISPONIBLES"**).
   - Reserva manual en 1 clic.
3. **Mis Reservas & Código QR Oficial (Imagen 3):**
   - Muestra los tickets activos con el **Código QR oficial** renderizado con alto contraste y color institucional (`#07406b`).
   - **Pase Digital en Pantalla Completa:** Tarjeta lista para mostrar al lector del comedor o ventanilla de atención.
   - Opción para anular la reserva y liberar el cupo.
4. **Ficha de Asistencias:**
   - Contador de inasistencias (0 / 3) y estado de habilitación de matrícula.

---

## ⚡ Rendimiento y Consumo de Memoria

* **Consumo de RAM en reposo:** ~38 MB - 50 MB (ideal para el plan gratuito de Railway con 512 MB).
* **Cero librerías pesadas:** Construido sobre las APIs nativas de Node.js (`http`, `fetch`, `crypto`).
* **Estilo Visual:** Limpio, minimalista, paleta corporativa universitaria (blanco, gris pizarra, azul marino `#07406b`), **completamente libre de neón**.
