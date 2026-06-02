\getenv grafana_readonly_user PHOENIX_POSTGRES_GRAFANA_USER
\getenv grafana_readonly_password PHOENIX_POSTGRES_GRAFANA_PASSWORD

SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'grafana_readonly_user',
  :'grafana_readonly_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'grafana_readonly_user')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'grafana_readonly_user')
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'grafana_readonly_user')
\gexec

SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I', :'grafana_readonly_user')
\gexec

SELECT format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'grafana_readonly_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO %I', :'grafana_readonly_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I', :'grafana_readonly_user')
\gexec
