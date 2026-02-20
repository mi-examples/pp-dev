/**
 * Fetches and returns the `data` field for a dataset by its numeric ID.
 *
 * @param datasetId - The dataset identifier used as the `dataset` query parameter
 * @returns The `data` property extracted from the response JSON
 */
export async function getDatasetData(datasetId: number) {
  return await fetch(`/api/dataset_data?dataset=${datasetId}`, {
    headers: { accept: 'application/json' },
  }).then(async (res) => (await res.json()).data);
}