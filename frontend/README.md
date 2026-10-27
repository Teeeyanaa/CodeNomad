# CodeNomad frontend

This is the separate browser-facing half of the project. The Soroban
contracts, agents, generated bindings, and x402 service remain under
`../oracledesk-stellar/`.

## Run

```bash
npm start
```

Open <http://localhost:4173>. The optional x402 status indicator checks
`http://localhost:3000/health`; set `localStorage.oracledeskApiUrl` in the
browser to point it at another API URL.