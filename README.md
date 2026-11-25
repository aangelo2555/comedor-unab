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

Las filas de alumnos omiten contraseñas y tokens institucionales en texto claro. Con `INSTITUTION_CREDENTIAL_KEY` configurada se guarda un almacén cifrado AES-256-GCM separado, asociado al identificador y código de cada alumno. Se recuperan las credenciales al iniciar y se renueva la sesión sin intervención del alumno. Los respaldos administrativos descargables omiten por completo el almacén cifrado y las sesiones. Las sesiones web persistidas se identifican mediante hashes de sus tokens. Los respaldos nativos de PostgreSQL pueden contener el almacén cifrado, pero no la clave del entorno.

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

La comprobación del último minuto utiliza los tokens vigentes directamente y renueva los que lo necesitan. Una sesión ya preparada puede reservar mientras termina una comprobación de fondo. Con la recuperación cifrada configurada se recuperan las credenciales después de un reinicio. Sin clave o sin credenciales guardadas previamente, el alumno deberá ingresar una vez. Su panel indica cuándo necesita hacerlo.

El sondeo inicial de publicación se programa cada 250 ms, sujeto al presupuesto global de peticiones. El centinela revisa cada segundo cuando está libre. Las operaciones de apertura tienen preferencia sobre consultas ordinarias dentro de ese presupuesto. Las consultas y los reintentos ordinarios continúan con dos peticiones simultáneas y 500 ms entre inicios. El primer lote de POST de apertura utiliza el modo paralelo descrito más abajo. Los errores temporales y `Retry-After` mantienen sus esperas.

El primer procesamiento comienza al detectar el servicio. El tiempo total depende del ritmo permitido y de UNAB. El lote de apertura no utiliza el espaciado de las consultas ordinarias. Su duración sigue dependiendo de que las sesiones estén preparadas y de las respuestas de la institución.

## Administración de Premium y autenticación

Solo el administrador puede activar Premium, seleccionar desayuno/almuerzo/cena, configurar el fin de ciclo y habilitar la cancelación preventiva. El endpoint de preferencias del alumno rechaza cambios con HTTP 403. El modal del alumno es informativo y enlaza a https://wa.me/51923887478; no registra solicitudes ni modifica el plan al abrir WhatsApp. La revocación de autorización y las cancelaciones manuales siguen disponibles.

El login acepta `accessToken`, `access_token` o `token` en la raíz y en los contenedores `data`/`result`. Las respuestas exitosas sin token se reintentan una vez a través del límite compartido. Si siguen sin sesión, la solicitud conserva su posición: no se interpreta como falta de cupos. Las renovaciones fallidas tienen pausas progresivas de 5 a 30 segundos. Un HTTP 201 sin token sigue siendo una respuesta insuficiente del proveedor; no se inventa una sesión ni se garantiza la disponibilidad externa.

## Invitación y contadores del panel

Los alumnos ordinarios ven la invitación informativa a Premium al entrar en su panel, incluso cuando se recupera su sesión. Las actualizaciones periódicas no vuelven a abrirla. La activación del plan sigue siendo administrativa.

La tabla y su resumen utilizan la misma lista de solicitudes pendientes. Se distinguen solicitudes y alumnos únicos, y se muestran aparte los alumnos del servicio actual en Centinela y los que tienen autenticación pendiente. La autenticación pendiente no excluye al alumno de la cola. Las cuentas inactivas o con automatización pausada conservan sus solicitudes y muestran ese estado explícito.

Una sesión web guardada no equivale a una sesión institucional lista. Si no hay recuperación cifrada configurada o la cuenta aún no guardó sus credenciales y el reinicio deja al alumno sin token vigente y sin credenciales en memoria, el motor conserva su solicitud y marca «El alumno debe volver a ingresar». Ese caso no envía un login vacío ni se registra como error de comunicación. El aviso al alumno llega por su conexión de eventos; al recuperar una sesión institucional válida se limpia el estado pendiente. El disparo y Centinela respetan el mismo filtro de cuentas activas con automatización habilitada.

## Configuración de recuperación automática

1. Genera una clave fuera del chat con `openssl rand -base64 32`.
2. Guarda el resultado como variable secreta `INSTITUTION_CREDENTIAL_KEY` del servicio de la aplicación en Railway. Conserva la misma clave al reemplazar contenedores y despliegues. No la pongas en Git ni en la base.
3. Utiliza PostgreSQL persistente o un volumen persistente para `DATA_DIR`.
4. Los alumnos cuyas credenciales ya se perdieron deberán ingresar una vez. Los siguientes reinicios recuperarán su contraseña y token cifrados.

La ausencia de clave conserva el modo en memoria y se avisa al iniciar. Una clave mal formada impide iniciar para evitar una protección aparente. Una clave válida pero incorrecta o un cifrado alterado no se utiliza para autenticar; se conserva el registro cifrado para poder recuperar con la clave correcta. Retirar la autorización o eliminar una cuenta elimina también su entrada del almacén en las siguientes escrituras; los respaldos históricos requieren su gestión correspondiente. No cambies la clave sin planificar la recuperación de las cuentas.

Contingencias verificadas: renovación por vencimiento; renovación compartida entre peticiones simultáneas; un solo reintento de lecturas rechazadas con HTTP 401; verificación de calentamiento sin esperarse a sí misma; respuestas HTTP 201 sin token; demoras y cuerpos de respuesta bloqueados; 429/Retry-After y pausa por 403; reconciliación de reservas cuando se pierde la respuesta; y preservación de solicitudes/prioridad. Los POST de reserva no se repiten a ciegas. Solo un rechazo explícito de credenciales detiene intentos con esa misma contraseña hasta corregirla o volver a autenticarse; un HTTP 401 genérico del portal mantiene reintentos con pausa sin exigir otro login; cambios de contraseña, bloqueos, MFA y caídas del proveedor pueden requerir intervención. No se garantiza éxito ante todos los fallos externos.

## Reservas puntuales del alumno Premium

El panel Premium ofrece los tres servicios de hoy, además de sus solicitudes automáticas y sus pases. Cancelar una solicitud no modifica el plan recurrente y no provoca que se vuelva a crear automáticamente ese mismo día; el alumno puede reactivarla explícitamente o pedir otro servicio. Reactivar conserva un único registro por alumno, fecha y servicio. Un ticket anulado anterior no oculta una solicitud nueva, y un ticket confirmado se distingue de una solicitud en cola. Los servicios consumidos no permiten otra reserva del mismo servicio y día.

Los controles de cola solo cancelan solicitudes propias sin ticket confirmado; los tickets se cancelan desde los pases. Las cancelaciones y las nuevas solicitudes refrescan las vistas relacionadas. Si la institución no confirma disponibilidad, se muestran cupos desconocidos y se permite dejar la solicitud local; el coordinador comprueba tickets y disponibilidad antes de escribir en la institución. Un fallo de consulta de tickets no se presenta como ausencia de tickets.

El administrador conserva el control de la activación, servicios recurrentes, fin de ciclo y cancelación preventiva. Su panel avisa si no está configurada la clave de recuperación entre reinicios. El alumno no ve promociones para contratar Premium dentro de su panel Premium. Las renovaciones temporales se muestran como recuperación automática; se solicita intervención solo si faltan credenciales/autorización o el proveedor rechaza explícitamente los datos de acceso.

## Latencia del disparo de apertura

El lote prepara hasta 50 operaciones sin esperar la confirmación de los primeros alumnos. Las consultas y reintentos ordinarios siguen aplicando `UNAB_MAX_CONCURRENCY` (2 por defecto) y `UNAB_REQUEST_INTERVAL_MS` (500 ms por defecto). Los POST del primer lote de apertura salen en paralelo, sin ese espaciado, mediante una autorización interna limitada a un envío por candidato, un máximo de 50 y una vigencia de 10 segundos. Se crea solo cuando la programación se detecta durante el primer minuto del horario oficial. `UNAB_OPENING_CONCURRENCY` permite reducir la concurrencia de apertura y vale 50 por defecto. Las consultas que ya estaban en curso pueden coexistir con esos POST. Los POST de apertura tienen preferencia sobre verificaciones ordinarias; las operaciones Premium conservan mayor prioridad.

Durante la revisión del último minuto se comprueba también si ya existe un ticket para el servicio. Solo una comprobación correcta sin ticket genera una preparación reutilizable, ligada al alumno, fecha, servicio, token y hora de apertura. Esa comprobación debe tener menos de 90 segundos y solo se acepta durante los primeros 2,5 segundos tras la apertura; se revisa otra vez al salir de la cola de red. Si caduca, se realiza una consulta fresca antes del POST. Las cancelaciones y la detención del motor invalidan la preparación, y la deduplicación por alumno/fecha/servicio permanece activa. La comprobación no es un bloqueo de operaciones realizadas desde el portal institucional.

Los registros `[LATENCIA]` indican el tiempo desde la detección de programación hasta el inicio del primer POST y su espera interna. Los registros de reserva confirmada miden la llegada del resultado, no el momento de envío. `lastDispatchTiming` expone los agregados del último lote en el estado del motor. El motor no procesa una programación publicada antes de que comience el horario oficial. Nunca se promete confirmación en milisegundos: la latencia y la aceptación del proveedor siguen determinando el resultado del lote. Las pausas por saturación, 429/Retry-After y bloqueos 403 también se aplican al modo paralelo. No se acelera el login ni se repiten POST a ciegas.

Si el motor se arma durante el último minuto, la comprobación previa de tickets se inicia inmediatamente, sin esperar otro temporizador. Las credenciales faltantes permanecen pendientes y no retrasan a las sesiones que ya están listas. Los registros de latencia incluyen el inicio del primer y del último POST del lote para distinguir el despacho de la confirmación institucional.
