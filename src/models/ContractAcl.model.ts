import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

export type AclStatus = "active" | "removed";

/**
 * Current on-chain ACL entry for a whitelisted contract. Kept in sync from
 * `ACLUpdated` contract events so admins can inspect which integrations are
 * permitted, and which functions each one may call.
 */
@Entity("contract_acls")
@Index("idx_contract_acls_contract_address", ["contractAddress"], { unique: true })
export class ContractAcl {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "contract_address", type: "varchar", length: 56 })
  contractAddress!: string;

  /** Functions the whitelisted contract is permitted to invoke. */
  @Column({ name: "permitted_functions", type: "jsonb", default: () => "'[]'::jsonb" })
  permittedFunctions!: string[];

  @Column({ type: "varchar", length: 16, default: "active" })
  status!: AclStatus;

  @Column({ name: "added_at", type: "timestamptz" })
  addedAt!: Date;

  @Column({ name: "removed_at", type: "timestamptz", nullable: true })
  removedAt!: Date | null;

  @Column({ name: "last_ledger", type: "bigint", nullable: true })
  lastLedger!: string | null;

  @Column({ name: "last_tx_hash", type: "varchar", length: 64, nullable: true })
  lastTxHash!: string | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
