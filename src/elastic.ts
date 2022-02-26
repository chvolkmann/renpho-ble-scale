import { Client } from "@elastic/elasticsearch";

const es = new Client({ node: "http://localhost:9200" });

export const writeMeasurement = async (val: number) => {
  return await es.index({
    index: "measurements",
    document: {
      created: new Date().toISOString(),
      kind: "weight",
      value: val,
    },
  });
};
