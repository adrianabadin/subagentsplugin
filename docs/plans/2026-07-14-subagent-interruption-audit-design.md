# Auditoria de interrupciones de subagentes

El plugin registrara las interrupciones que solicita directamente sobre sesiones de subagentes y mostrara el motivo inmediatamente en el CLI. El objetivo es explicar abortos, rechazos y timeouts que hoy pueden consumir tokens sin dejar una causa visible.

## Quick path

1. El plugin registra la intencion antes de llamar a `session.abort`.
2. Emite una linea de diagnostico en `stderr` con la causa y los identificadores de la sesion.
3. Escribe eventos JSONL en `.opencode/logs/subagent-interruptions.jsonl`.
4. Registra el resultado del abort como `abort_resolved`, `abort_rejected` o `abort_timeout`.

## Decisiones

| Tema | Decision |
| --- | --- |
| Alcance | Solo interrupciones solicitadas por el plugin; no se atribuyen al plugin cancelaciones del usuario ni eventos externos. |
| Archivo | `.opencode/logs/subagent-interruptions.jsonl`, append-only, una linea JSON por evento. |
| Salida CLI | Una linea inmediata en `stderr` para cada evento, con prefijo `model-forecast` y el motivo legible. |
| Correlacion | `sessionID`, `parentSessionID`, `callID` y `attemptID` cuando existan. |
| Eventos | `abort_requested`, `abort_resolved`, `abort_rejected`, `abort_timeout`. |
| Causas | `origin`, `reason` y `error` opcional; no se registra una tarea completada como interrupcion. |
| Robustez | Los errores de escritura del log no pueden romper el hook ni el fallback. |
| Privacidad operativa | El archivo queda ignorado por Git; no se persisten prompts completos, solo metadatos de correlacion y motivos. |

## Flujo

Antes de cada `session.abort`, el plugin crea un registro de causalidad en memoria y escribe `abort_requested`. Luego ejecuta el abort con un deadline. El resultado se cierra con un evento adicional:

- `abort_resolved`: el SDK resolvio la solicitud.
- `abort_rejected`: el SDK rechazo la solicitud y se conserva un codigo cerrado y clasificado (`abort_rejected_bad_request`, `abort_rejected_not_found`, `abort_rejected_cancelled`, `abort_rejected_timeout`, `abort_rejected_transport` o `abort_rejected_unknown`), nunca el mensaje arbitrario del SDK.
- `abort_timeout`: el SDK no resolvio dentro del deadline.

Cada evento se escribe de forma independiente para que un proceso interrumpido deje al menos evidencia de la solicitud inicial. La salida del CLI usa el mismo registro, pero en formato humano y de una sola linea.

## Fuera de alcance

- Inferir que una sesion fue interrumpida cuando el plugin nunca llamo a `session.abort`.
- Reemplazar la salida nativa de OpenCode.
- Persistir prompts, respuestas o contenido generado por el subagente.
- Agregar un comando CLI separado para consultar el archivo; el archivo JSONL queda disponible para auditorias y herramientas externas.

## Criterios de aceptacion

- [ ] Cada abort iniciado por el plugin genera una linea JSON valida y una linea visible en el CLI.
- [ ] Un abort resuelto, rechazado o expirado genera el evento final correspondiente.
- [ ] El registro contiene la razon que disparo la interrupcion y los identificadores disponibles.
- [ ] Una falla de filesystem no interrumpe la ejecucion del plugin.
- [ ] Las tareas completadas no generan eventos de interrupcion.
- [ ] Los tests verifican formato, correlacion, salida CLI y tolerancia a errores de escritura.

## Siguiente paso

Implementar el sink de auditoria en el logger del proyecto y conectarlo al wrapper centralizado de `session.abort`, manteniendo el contrato best-effort del plugin.
