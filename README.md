# Mi Mesa

Realizado por FSO. Proyecto independiente de ayuda para organizar comidas. Premium se configura desde el portal del administrador y tiene prioridad en la cola; los aportes voluntarios se gestionan por separado. La integración real sigue sujeta a las reglas y autorizaciones de la institución.

## Ejecución

Requiere Node.js 18 o superior. Instala las dependencias con `npm ci` y ejecuta `npm start`. El puerto predeterminado es 3000. `/healthz` informa la disponibilidad y el almacenamiento activo.

En una instalación nueva configura `ADMIN_EMAIL` y `ADMIN_PASSWORD` mediante variables privadas. El sistema conserva las credenciales administrativas migradas salvo una sustitución explícita por variables. Las nuevas escrituras usan scrypt para contraseñas administrativas. Se retiraron las credenciales personales de ejemplo del código de inicialización.

## Identificación y habilitación

El crédito FSO no sustituye la identificación del responsable. Las variables siguientes permiten configurar el estado público en `/api/service-policy` y la página `/terminos.html`.

| Variable | Uso |
| --- | --- |
| `SERVICE_OPERATOR` | Nombre o razón social del responsable real |
| `SERVICE_CONTACT_EMAIL` | Correo operativo para soporte, privacidad y aportes |
| `VOLUNTARY_CONTRIBUTIONS_ENABLED` | `true` permite mostrar el canal de aportes cuando hay identificación y contacto |
| `CONTRIBUTION_YAPE` | Número del receptor de los aportes, confirmado por el responsable |

Los estudiantes ingresan con sus propias credenciales y autorización de tratamiento, sin activación por parte del administrador ni dependencia de la identificación del proyecto. El acceso y la elegibilidad se validan con el sistema institucional. El administrador ingresa con su cuenta administrativa. El responsable debe completar el aviso de privacidad y sus obligaciones aplicables. El canal de aportes sigue deshabilitado por defecto y requiere identificación y contacto configurados.

## Premium y gestión administrativa

El estudiante acepta los términos y el tratamiento para autenticarse. El administrador gestiona la activación de Premium, sus servicios, su fin de ciclo y la cancelación preventiva. La configuración registra su origen administrativo y el responsable que la realizó; no se presenta como consentimiento otorgado por el alumno.

El alumno puede consultar su plan y contactar por WhatsApp al responsable. Los cambios del plan se realizan en el portal administrativo. Retirar la autorización elimina las credenciales en memoria, deshabilita la automatización, anula solicitudes locales pendientes y cierra sesiones. Conserva los tickets ya confirmados y el historial existente.

La ruta de checkout anterior responde HTTP 410 y no registra pagos ni habilita funciones. Los pagos históricos se conservan pendientes de atención directa por el responsable cuando corresponda.

## Persistencia y credenciales

Configura PostgreSQL mediante `DATABASE_URL` o `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` y `PGPASSWORD`. La tabla `comedor_state` conserva el estado en JSONB con revisión de concurrencia. Ejecuta una sola réplica. Sin PostgreSQL se utiliza `DATA_DIR/database.json`, que necesita volumen persistente en despliegues reemplazables.

Las nuevas escrituras, incluida la de inicialización, omiten contraseñas y tokens institucionales de estudiantes. Se utilizan en memoria y se pierden al reiniciar. La siguiente sesión institucional exige reautenticación, por lo que la automatización puede quedar pendiente tras un reinicio. Los respaldos administrativos nuevos omiten esas credenciales y las sesiones. Las sesiones persistidas se identifican mediante hashes de sus tokens.

Los archivos y respaldos históricos previos pueden contener datos o credenciales. El responsable debe revisarlos, protegerlos, rotar credenciales expuestas y resolver su eliminación conforme a sus obligaciones. `data/` y `config.json` se excluyen de Git y de las imágenes Docker. Las copias locales se conservan. Esta actualización no borra archivos históricos ni reescribe el historial Git. El cliente de consola anterior fue retirado porque omitía los controles del servidor.

El acceso a eventos exige sesión. Los detalles de auditoría y controles globales se restringen a administradores. Los estudiantes reciben avisos para refrescar sus vistas sin detalles de otros usuarios.

## Railway y contenedores

Railway usa `Dockerfile` y `railway.json`, una réplica y comprobación `/healthz`. Conecta PostgreSQL mediante referencia de variables del proyecto. Conserva un respaldo antes de modificar el almacenamiento. La importación automática de JSON ocurre cuando PostgreSQL está vacío y el archivo está disponible en el contenedor. Una base existente conserva su estado.

Para Docker Compose configura de forma privada `POSTGRES_PASSWORD`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` y ejecuta `docker compose up --build -d`. `docker compose down` conserva el volumen.

## Verificación

Ejecuta `node --test tests/*.test.js`. Las pruebas de red utilizan respuestas simuladas. Las pruebas de integración PostgreSQL requieren `PG_TEST_CONFIG` con la ruta a un archivo privado con las variables de una instancia de pruebas y permiso para crear y eliminar bases aisladas. No uses la base de producción para esas pruebas.

Los términos describen el comportamiento implementado y sus pendientes. El cambio de marca y el modelo de aportes no constituyen una certificación de legalidad.


## Cupo y orden de registro

El límite es de 50 alumnos. Las cuentas de administración quedan fuera del cupo. La antigüedad de las cuentas de alumnos se guarda con un orden de registro persistente. En cuentas anteriores, se utiliza la fecha de creación disponible y se conserva el orden del archivo para registros sin fecha. Los registros nuevos se añaden al final.

El registro normal y el registro desde administración comprueban el cupo. La comprobación final se repite al guardar, después de autenticar con la institución, para impedir que dos registros simultáneos ocupen la última plaza. El alumno ve su posición y el límite en su panel.

Si ya existen más de 50 alumnos, sus cuentas y solicitudes permanecen guardadas. Los primeros 50 registros participan en nuevas reservas y automatizaciones. El resto puede ingresar y consultar su posición, con las nuevas reservas bloqueadas. Las cuentas desactivadas conservan su lugar de registro. Las cancelaciones previamente autorizadas de tickets existentes siguen su flujo habitual.

Las solicitudes de cada comida se procesan primero para Premium. Dentro de cada grupo se respeta la antigüedad de registro y después la fecha de solicitud. Los aportes voluntarios se gestionan por separado.

## Preparación de sesiones y apertura

La preparación comienza cinco minutos antes de la apertura. Se vuelve a revisar la cola un minuto antes para incorporar alumnos recién ingresados y renovar tokens próximos a vencer. La vigencia requerida cubre la apertura y al menos dos minutos posteriores. Se utilizan dos trabajadores de preparación y se omite la consulta opcional del perfil durante ese paso.

La comprobación del último minuto utiliza los tokens vigentes directamente y renueva los que lo necesitan. Una sesión ya preparada puede reservar mientras termina una comprobación de fondo. Las credenciales institucionales se conservan en memoria, por lo que un reinicio puede exigir que el alumno vuelva a ingresar. Su panel indica cuándo necesita hacerlo.

El sondeo inicial de publicación se programa cada 250 ms, sujeto al presupuesto global de peticiones. El centinela revisa cada segundo cuando está libre. Las operaciones de apertura tienen preferencia sobre consultas ordinarias dentro de ese presupuesto. El límite inicial continúa siendo dos peticiones simultáneas, con 500 ms entre inicios. Los errores temporales y `Retry-After` mantienen sus esperas.

El primer procesamiento comienza al detectar el servicio. El tiempo total depende del ritmo permitido y de UNAB. Con dos inicios por segundo, 50 envíos requieren al menos 25 segundos, además de las verificaciones de tickets y la latencia de las respuestas.

## Administración de Premium y autenticación

Solo el administrador puede activar Premium, seleccionar desayuno/almuerzo/cena, configurar el fin de ciclo y habilitar la cancelación preventiva. El endpoint de preferencias del alumno rechaza cambios con HTTP 403. El modal del alumno es informativo y enlaza a https://wa.me/51923887478; no registra solicitudes ni modifica el plan al abrir WhatsApp. La revocación de autorización y las cancelaciones manuales siguen disponibles.

El login acepta `accessToken`, `access_token` o `token` en la raíz y en los contenedores `data`/`result`. Las respuestas exitosas sin token se reintentan una vez a través del límite compartido. Si siguen sin sesión, la solicitud conserva su posición: no se interpreta como falta de cupos. Las renovaciones fallidas tienen pausas progresivas de 5 a 30 segundos. Un HTTP 201 sin token sigue siendo una respuesta insuficiente del proveedor; no se inventa una sesión ni se garantiza la disponibilidad externa.
