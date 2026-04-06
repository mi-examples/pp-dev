import $ from 'jquery';

export async function getDatasetData(datasetId: number): Promise<unknown> {
  const data = await $.ajax({
    url: `/api/dataset_data`,
    method: 'GET',
    data: { dataset: datasetId },
    dataType: 'json',
    headers: { Accept: 'application/json' },
    xhrFields: { withCredentials: true },
    timeout: 25000,
  });
  
  return (data as { data?: unknown }).data;
}
