# Implementacion Deterministica de Config Global de Forecast

## Summary

Objetivo: hacer que los cambios hechos desde el menu de forecast modifiquen una configuracion global y que la eleccion de modelos use esa configuracion de forma deterministica.

La precedencia sera:

`registry compilado < overrides globales < overrides locales del repo`

Esto mantiene proveedores distintos (`deepseek/*` y `opencode-go/*`) y permite marcar `opencode-go/deepseek-v4-pro` como `unavailable` sin afectar automaticamente `deepseek/deepseek-v4-pro`.

## Key Changes

- Crear un loader/saver global para benchmarks, usando una ruta estable bajo el home/cache/config del plugin, por ejemplo:
  `~/.config/opencode-model-forecast/benchmarks.json`
- Cambiar el menu TUI/CLI de configuracion para editar el archivo global por defecto, no `forecast-data/benchmarks.json`.
- Mantener `forecast-data/benchmarks.json` como override local opcional por repo.
- Agregar una funcion unica de inicializacion, por ejemplo `loadEffectiveBenchmarks(rootDir)`, que:
  - carga overrides globales,
  - carga overrides locales si existen,
  - aplica merge replace-by-key,
  - llama `setRepoLocal(effectiveOverrides)`.
- Invocar esa inicializacion antes de:
  - `generateProfilesForConfig()` en `modelForecastPlugin()`,
  - `forecast()` cuando se ejecute desde CLI,
  - cualquier comando CLI que use `lookupBenchmark()` / `lookupEvidence()` para decision o scoring.

## Implementation Tasks

1. Escribir test fallido para configuracion global:
   - Crear un directorio temporal con archivo global `benchmarks.json`.
   - Marcar `opencode-go/deepseek-v4-pro` como `unavailable`.
   - Generar perfiles con un modelo conectado `opencode-go/deepseek-v4-pro`.
   - Esperar que no se genere ningun perfil para ese modelo.

2. Implementar helper global:
   - Nuevo modulo o extension de `repo-data.ts`.
   - Exportar:
     - `globalBenchmarksPath()`
     - `loadGlobalBenchmarks()`
     - `saveGlobalBenchmarks()`
     - `loadEffectiveBenchmarks({ rootDir, globalPath? })`
   - Reutilizar `isBenchmarkEntry`.
   - No hacer deep merge: cada entry reemplaza por `key`.

3. Cambiar config TUI/CLI:
   - `loadConfigState()` debe cargar desde global.
   - `saveConfigState()` debe guardar en global.
   - Permitir inyeccion de path en tests para evitar tocar home real.
   - Actualizar textos visibles si mencionan `forecast-data`.

4. Conectar runtime:
   - En `modelForecastPlugin()`, antes del hook `config` o al inicio del hook, cargar effective benchmarks y llamar `setRepoLocal`.
   - En CLI forecast, cargar effective benchmarks antes de ejecutar `forecast()`.
   - Si falla la lectura del archivo global/local, fallback silencioso al registry compilado y log warning no fatal.

5. Actualizar tests existentes:
   - Tests de `repo-data` para precedencia: compiled < global < repo-local.
   - Tests de `profiles` para confirmar que `unavailable` global excluye perfiles.
   - Tests de CLI/config para confirmar que save escribe global.
   - Mantener test que confirma que proveedores siguen separados.

## Test Plan

- Red test:
  `npm test -- --run tests/profiles.test.ts tests/repo-data.test.ts`
  debe fallar antes de implementar.

- Green test:
  `npm test -- --run tests/profiles.test.ts tests/repo-data.test.ts tests/cli-config.test.ts`

- Full verification:
  `npm test`

- Manual check:
  - Marcar `opencode-go/deepseek-v4-pro` como `unavailable` desde menu/config.
  - Confirmar que el archivo global se modifica.
  - Reiniciar sesion/plugin.
  - Confirmar que forecast ya no sugiere ese modelo.

## Assumptions

- No se agrupan `deepseek/*` y `opencode-go/*`; siguen siendo proveedores distintos.
- El archivo local `forecast-data/benchmarks.json` queda soportado como override por repo.
- Si global y local definen la misma key, gana local.
