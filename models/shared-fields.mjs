export function idField({ nullable = true } = {}) {
  const { StringField } = foundry.data.fields;
  return new StringField({ required: true, nullable, initial: null, blank: false });
}

export function stringArrayField() {
  const { ArrayField, StringField } = foundry.data.fields;
  return new ArrayField(new StringField({ required: true, nullable: false, blank: false }), {
    required: true,
    nullable: false,
    initial: []
  });
}

export function timestampField() {
  const { NumberField } = foundry.data.fields;
  return new NumberField({ required: true, nullable: true, initial: null, integer: true, min: 0 });
}

export function schemaVersionField() {
  const { NumberField } = foundry.data.fields;
  return new NumberField({ required: true, nullable: false, initial: 1, integer: true, min: 1 });
}
