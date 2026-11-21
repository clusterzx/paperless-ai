import { PaperlessBackend } from '../../src/server/backend/paperless.js';
import { MetadataCache } from '../../src/server/backend/metadata.js';
import { MockPaperless } from '../helpers/mockPaperless.js';
import { backendContract, PDF, type SeedDoc } from './contract.js';

backendContract('Paperless-ngx (mock, API v10)', async () => {
  const mock = await new MockPaperless({ minVersion: 9, maxVersion: 10 }).start();
  let meta: MetadataCache | null = null;
  const backend: PaperlessBackend = new PaperlessBackend({ url: mock.url, token: mock.token, metadata: (): MetadataCache => (meta ??= new MetadataCache(backend.metadataSource(), 0)) });
  return {
    backend,
    async seed(docs: SeedDoc[]) {
      const named = (map: (n: string) => { id: number } | undefined, add: (n: string) => { id: number }, name?: string) =>
        name ? (map(name) ?? add(name)).id : null;
      return docs.map(
        (d) =>
          mock.addDocument({
            title: d.title,
            content: d.content,
            created: d.created,
            tags: (d.tags ?? []).map((t) => named((n) => mock.tagByName(n), (n) => mock.addTag(n), t)!),
            correspondent: named((n) => mock.correspondentByName(n), (n) => mock.addCorrespondent(n), d.correspondent),
            document_type: named((n) => mock.documentTypeByName(n), (n) => mock.addDocumentType(n), d.documentType),
            file: d.file ? { data: d.file.data, contentType: d.file.contentType } : { data: PDF, contentType: 'application/pdf' },
            original_file_name: d.file?.filename ?? `${d.title}.pdf`,
          }).id,
      );
    },
    close: () => mock.close(),
  };
});
