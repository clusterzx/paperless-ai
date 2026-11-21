# Runs inside the Paperless-ngx image after document_importer (manage.py shell < check.py).
from documents.models import CustomFieldInstance, Document, Tag

assert Document.objects.count() == 3, Document.objects.count()
assert Document.objects.filter(title="Stromrechnung März 2024", correspondent__name="Stadtwerke München").exists()
assert Tag.objects.filter(name="Rechnung").exists()
assert CustomFieldInstance.objects.filter(value_monetary="EUR84.20").exists()
# The checksums of the manifest are stored as they are; the sanity checker compares them with the files.
from documents.sanity_checker import check_sanity

report = str(getattr(check_sanity(), "_messages", ""))
assert "Checksum mismatch" not in report, report
print("round trip ok")
