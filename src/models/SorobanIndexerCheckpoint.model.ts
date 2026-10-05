import { Column, Entity, UpdateDateColumn } from "typeorm";

@Entity("soroban_indexer_checkpoints")
export class SorobanIndexerCheckpoint {
  @Column({ name: "checkpoint_key", type: "varchar", length: 255, primary: true })
  checkpointKey!: string;

  @Column({ name: "ledger_sequence", type: "bigint" })
  ledgerSequence!: string;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
