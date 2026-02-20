/**
 * Fetches dataset-specific data from the `/api/dataset_data` endpoint.
 *
 * @param datasetId - The numeric dataset identifier sent as the `dataset` query parameter
 * @returns The value of the `data` property from the endpoint's JSON response
 */
export async function getDatasetData(datasetId: number) {
  return await fetch(`/api/dataset_data?dataset=${datasetId}`, {
    headers: { accept: 'application/json' },
  }).then(async (res) => (await res.json()).data);
}