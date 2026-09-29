-- =============================================================================
-- schema.sql — Esquema de Autenticacion-alternativa
-- Microservicio exclusivo de dispositivos GPS.
-- Sin tablas de usuarios, trailers ni tractocamiones.
--
-- Aplicar manualmente en Cloud SQL desde el Bastion:
--   psql -h <IP_PRIVADA_CLOUD_SQL> -U <DB_USER> -d <DB_NAME> -f schema.sql
-- =============================================================================

-- =============================================================================
-- TABLA: dispositivo
-- Almacena dispositivos GPS identificados por IMEI.
-- La identidad autorizada es el hardware; no se relaciona con entidades vehiculares.
-- =============================================================================
CREATE TABLE IF NOT EXISTS "dispositivo" (
  "imei"              varchar(15) NOT NULL,
  "sensores"          jsonb       NOT NULL DEFAULT '{}',
  "estado"            boolean     NOT NULL DEFAULT false,
  "hora_ultimo_login" TIMESTAMP WITH TIME ZONE,
  CONSTRAINT "PK_dispositivo_imei" PRIMARY KEY ("imei")
);

-- Índice del barrido periódico de inactividad del DispositivoService.
CREATE INDEX IF NOT EXISTS "IDX_dispositivo_status_check"
  ON "dispositivo" ("estado", "hora_ultimo_login");

-- IMEIs de prueba para el piloto. Revisar/reemplazar antes de producción.
INSERT INTO "dispositivo" ("imei", "sensores", "estado")
VALUES
  ('865124073321376', '{"temperatura": 1, "puerta": 1}', false)
ON CONFLICT ("imei") DO NOTHING;
