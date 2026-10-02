import { Entity, PrimaryGeneratedColumn, Column } from "typeorm";
import { KYCStatus } from "@/types/enums";

@Entity()
export class User {
  @PrimaryGeneratedColumn("uuid")
  id!: string; // '!' tells TS this will be assigned by TypeORM

  @Column({ unique: true })
  email!: string;

  @Column({ type: "enum", enum: KYCStatus, default: KYCStatus.PENDING })
  kycStatus!: KYCStatus;
}
