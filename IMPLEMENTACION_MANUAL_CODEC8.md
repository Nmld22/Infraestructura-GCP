# Procedimiento manual de Codec8 y Cloud SQL

Este procedimiento complementa `deploy.sh`. Pulumi crea la infraestructura y la VM; el código Go se compila manualmente en la VM. El schema PostgreSQL se ejecuta manualmente desde el Bastion. Los datos AVL solo se imprimen en el journal de Codec8; no se llama al servicio Datos ni se persiste el JSON.

## Parámetros del stack

Determina los nombres efectivos según el stack (`pruebas`, `prod` o un nuevo stack como `dev` o `alternativa`):

- Bastion: `memoria-bastion` (pruebas), `memoria-bastion-prod` (prod) o `memoria-bastion-<stack>` (nuevo stack).
- VM Codec8: `memoria-codec-processor[-<stack>]`.
- Instancia Cloud SQL: `memoria-postgres-db[-<stack>]`.
- Base de autenticación: `memoria-auth-db[-<stack>]`.
- Puerto del servidor y TCP Load Balancer Codec8: `5001`.

Obtén el proyecto, zona, IP privada de Cloud SQL e IP pública TCP dedicada de Codec8 desde Pulumi/GCP:

```bash
pulumi stack output codecTcpLoadBalancerIp --stack <STACK>
gcloud sql instances describe $(pulumi stack output sqlInstanceName 2>/dev/null || echo "memoria-postgres-db-<STACK>") --project <PROJECT> --format='value(ipAddresses[0].ipAddress)'
```

Codec8 tiene una IP dedicada porque BC ya publica TCP 5001 en otra IP.

## Aplicar el schema desde Bastion

Ejecuta desde la máquina de administración, reemplazando proyecto y zona:

```bash
gcloud compute scp Autenticacion-alternativa/schema.sql memoria-bastion:~/schema.sql \
  --project <PROJECT> --zone <ZONE> --tunnel-through-iap
gcloud compute ssh memoria-bastion --project <PROJECT> --zone <ZONE> --tunnel-through-iap
```

Ya dentro del Bastion, conecta a Cloud SQL con el usuario configurado en Pulumi (`root`). `psql` solicitará la contraseña:

```bash
psql -h <CLOUD_SQL_PRIVATE_IP> -U root -d memoria-auth-db -f ~/schema.sql
psql -h <CLOUD_SQL_PRIVATE_IP> -U root -d memoria-auth-db -c 'SELECT imei, sensores, estado FROM dispositivo ORDER BY imei;'
```

Para producción usa la base con sufijo `-prod`. El schema incluye IMEIs de prueba del piloto; revisa esos inserts y usa inventario autorizado antes de habilitar dispositivos reales.

## Compilar y activar Codec8 en la VM

Después de que Pulumi cree la VM, copia el fuente y conéctate por IAP desde la máquina de administración:

```bash
gcloud compute scp memoria-servidor-codec8/main.go memoria-codec-processor:~/main.go \
  --project <PROJECT> --zone <ZONE> --tunnel-through-iap
gcloud compute ssh memoria-codec-processor --project <PROJECT> --zone <ZONE> --tunnel-through-iap
```

En la VM, instala Go si no está disponible, compila e instala el binario. El startup script ya creó `/etc/servidor-gps.env` y la unidad systemd:

```bash
sudo apt-get update
sudo apt-get install -y golang-go
go build -o /tmp/servidor-gps ~/main.go
sudo install -D -m 0755 /tmp/servidor-gps /opt/servidor-gps/servidor-gps
sudo systemctl daemon-reload
sudo systemctl enable --now servidor-gps
sudo systemctl status servidor-gps --no-pager
sudo ss -lntp | grep ':5001'
```

Confirma que `/etc/servidor-gps.env` tiene `PORT=5001`, `AUTH_SERVICE_URL` y `AUTH_VALIDATE_URL`. La cuenta de servicio de la VM usa el balanceador HTTP interno para invocar autenticación. Las líneas JSON aparecen en:

```bash
sudo journalctl -u servidor-gps -f
```

## Comprobación funcional

1. Confirma desde la VM que el servicio está activo y escucha en TCP 5001.
2. Envía un dispositivo Teltonika al IP dedicado de Codec8, puerto 5001.
3. Un IMEI registrado en `dispositivo` debe recibir el ACK de aceptación y cada paquete Codec8 válido debe imprimir un objeto JSON con `imei`, `receivedAt` y `records`.
4. Un IMEI no registrado o un JWT que no valide `sub=<IMEI>` y `type=dispositivo` debe recibir el ACK de rechazo; no se debe imprimir JSON.
5. Los paquetes AVL se confirman al dispositivo después de decodificarse e imprimirse correctamente.

El JSON no se envía ni se guarda en otro servicio en esta etapa.
