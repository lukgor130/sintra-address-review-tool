# Gaia Total App

Canonical home for the Vila Nova de Gaia PDM parcel explorer.

Primary source folder: `/apps/gaiatotal`
Target public URL: `https://maps.verrio.co/gaiatotal/`

## Data Sources

- Gaia PDM qualification: `https://opendata.gaiurb.pt/geoserver/wfs`
- Gaia PDM WMS constraints: `https://opendata.gaiurb.pt/geoserver/wms`
- Official cadastral parcels: `https://ogcapi.dgterritorio.gov.pt/collections/cadastro`
- Urban/rustic soil regime: `https://ogcapi.dgterritorio.gov.pt/collections/crus`

The app ships a cached CRUS PMTiles vector archive for Vila Nova de Gaia so the urban/rústico
regime loads locally and seamlessly. DGT Cadastro Predial was checked for Gaia, but the public OGC
API returned zero parcel features inside the municipality at cache time; the app still supports
uploading a local GeoJSON parcel file for private or curated parcel packs.

Regenerate the local CRUS tile cache with:

```bash
python3 scripts/build_gaia_data.py
```

This requires `tippecanoe` and `pmtiles` on the local machine.
