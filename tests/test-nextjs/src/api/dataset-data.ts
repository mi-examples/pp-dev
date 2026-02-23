export async function getDatasetData(datasetId: number) {
  return await fetch(`/api/dataset_data?dataset=${datasetId}`, {
    headers: { accept: 'application/json' },
  }).then(async (res) => (await res.json()).data);
}
