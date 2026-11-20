# Evaluación preliminar del servicio de automatización

Documento de trabajo del 20 de noviembre de 2026. Fuentes oficiales pendientes de consulta por bloqueo HTTP 403 de la red. Las normas enumeradas son referencias para verificar, no una certificación de su texto consolidado vigente. Esta evaluación no reemplaza la revisión de un abogado peruano con acceso al reglamento universitario y a la operación real.

## Respuesta a las preguntas

La automatización y el cobro no permiten concluir por sí solos que exista una infracción. Tampoco permiten afirmar que el servicio esté autorizado. La conclusión depende del alcance de las autorizaciones, las reglas de UNAB, la forma de acceso a sus sistemas, la afectación a otros usuarios y el cumplimiento de las obligaciones del proveedor.

La aceptación del estudiante autoriza únicamente aquello que él puede autorizar. Debe verificarse si UNAB permite delegar credenciales, automatizar solicitudes, cancelar tickets y explotar comercialmente esa integración. Un endpoint accesible y unas credenciales válidas no acreditan por sí solos permiso para cualquier uso.

## Aspectos que requieren revisión jurídica

| Área | Hecho relevante | Verificación pendiente |
| --- | --- | --- |
| Acceso y funcionamiento informático | El servidor inicia sesión y envía solicitudes a las APIs de UNAB en nombre del alumno | Alcance del acceso autorizado y aplicación de la Ley 30096 y sus modificatorias. Evaluar acceso ilegítimo, vulneración de medidas de seguridad y eventual afectación del funcionamiento. Los hechos y los elementos legales determinan si existe delito |
| Reglas universitarias | El comedor tiene cupos y condiciones de elegibilidad | Reglamento del comedor, reglamento disciplinario, condiciones del portal y política sobre credenciales. Consecuencias administrativas posibles aunque no exista delito |
| Protección de datos | Se conservan contraseñas recuperables, tokens, DNI, reservas y pagos | Ley 29733 y reglamento aprobado por DS 016-2024-JUS. Verificar consentimiento, seguridad, encargados, transferencias internacionales, banco de datos, conservación, derechos e incidentes según corresponda |
| Consumo | Se cobra S/ 9 por un servicio digital | Ley 29571. Revisar información previa, idoneidad, publicidad, duración, activación, devoluciones, cláusulas abusivas y Libro de Reclamaciones |
| Identidad y marca | El frontend utiliza el nombre y logo UNAB e ingreso institucional | Verificar autorización de uso y riesgo de confusión sobre el proveedor, patrocinio o respaldo. Revisar reglas de propiedad intelectual y competencia desleal aplicables |
| Tributación | Existe una prestación remunerada | Consultar SUNAT sobre RUC, actividad, régimen tributario y comprobantes. La calificación depende de cómo opera el proveedor |

La prioridad Premium se aplica dentro de la cola de esta aplicación. Debe evitarse describirla como prioridad concedida por la universidad. Las reservas y cancelaciones dependen de la respuesta oficial y de los cupos. El cobro no debe presentarse como compra de un cupo universitario ni como pase garantizado.

## Hallazgos del código anterior a la transición

- `db.js` conserva las contraseñas institucionales de manera recuperable. `postgres-store.js` persiste el documento completo en PostgreSQL. No se observó cifrado de campo para esas contraseñas en la aplicación. La seguridad de transporte y almacenamiento del proveedor requiere verificación independiente.
- Los respaldos administrativos exportan el estado de la aplicación y pueden incluir contraseñas, tokens y sesiones. Los accesos y la conservación de esas copias requieren controles.
- `premium-service.js` consulta tickets y puede cancelarlos si su estado oficial sigue siendo ACTIVA antes del cierre. El consentimiento debe explicar esa acción y sus consecuencias, incluso cuando haya retrasos en la actualización del estado.
- `premium-checkout.js` registra una solicitud pendiente. La activación requiere verificación del administrador. La fecha de fin del ciclo se configura administrativamente y debe quedar clara para el alumno antes del pago.
- El frontend muestra marca universitaria. La autorización o relación institucional no está acreditada en el material revisado.
- No se implementó en esta tarea consentimiento registrable, canal ARCO, política de conservación, procedimiento de devolución ni Libro de Reclamaciones. Una página de términos no implementa esos procesos.

## Documentos necesarios para cerrar la evaluación

Obtener el reglamento y las condiciones del portal y comedor, cualquier autorización escrita de UNAB, la identidad y contacto del proveedor, la configuración contractual y ubicación de Railway, los plazos reales de conservación y la política de devolución. Revisar con UNAB si existe una integración admitida para terceros y si admite un servicio remunerado.

La transición a Mi Mesa incorpora `public/terminos.html` enlazado desde el login y el pie, aceptación registrada y permisos separados para recurrencia y cancelación. La identidad y contacto se configuran mediante variables. El crédito FSO sigue sin identificar a una persona o razón social. El acceso del estudiante utiliza sus credenciales y su autorización de tratamiento y no depende de una activación del administrador. El canal de aportes permanece deshabilitado hasta completar su configuración.

La lógica de pago por funciones se retiró. El aporte es opcional y no concede prioridad ni activaciones. Los pagos históricos mantienen su naturaleza. Las nuevas escrituras omiten contraseñas y tokens institucionales y los respaldos nuevos omiten sesiones. Las contraseñas administrativas se almacenan con scrypt. Los archivos y respaldos históricos requieren revisión independiente y no fueron eliminados.

Estas medidas no acreditan autorización institucional ni completan el cumplimiento legal. Siguen pendientes la revisión de fuentes, identidad y contacto reales, obligaciones tributarias, conservación y eliminación de datos, gestión de encargados y transferencias y procedimientos de atención y reclamaciones. La configuración técnica tampoco prueba que exista autorización escrita.

## Fuentes oficiales para verificación

- [Ley 30096, Ley de Delitos Informáticos](https://www.leyes.congreso.gob.pe/Documentos/Leyes/30096.pdf). Consultar también sus modificatorias y el texto consolidado vigente.
- [Ley 29733, Ley de Protección de Datos Personales](https://www.leyes.congreso.gob.pe/Documentos/Leyes/29733.pdf).
- [Autoridad Nacional de Protección de Datos Personales](https://www.gob.pe/anpd). Localizar el DS 016-2024-JUS y las guías aplicables.
- [Ley 29571, Código de Protección y Defensa del Consumidor](https://www.leyes.congreso.gob.pe/Documentos/Leyes/29571.pdf).
- [Universidad Nacional de Barranca](https://www.unab.edu.pe/). Solicitar reglamentos y autorización pertinente.
- [Indecopi](https://www.gob.pe/indecopi). Verificar consumo, reclamaciones y uso de signos distintivos.
- [SUNAT](https://www.sunat.gob.pe/). Verificar inscripción y obligaciones de la actividad real.

El bloqueo fue comprobado para gob.pe, leyes.congreso.gob.pe y unab.edu.pe. Se requiere habilitar estos dominios en la red del entorno para efectuar la investigación documental solicitada. No se ha verificado una prohibición específica de UNAB ni una autorización para este servicio.
