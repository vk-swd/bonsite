CREATE DATABASE BankStatements;
GO

USE BankStatements;
GO
CREATE SCHEMA scm;
GO
CREATE TABLE scm.Users (
	id BIGINT IDENTITY(1,1)  PRIMARY KEY,
	Name NVARCHAR(100)
)
GO
CREATE TABLE scm.Statements (
	StatementId BIGINT PRIMARY KEY, -- ids should not auto increment for idempotency.
	Date DATETIME2(3) NOT NULL,
	Amount DECIMAL(18,2) NOT NULL,
	FromUserId BIGINT NOT NULL,
	ToUserId BIGINT NOT NULL,
	Status TINYINT NOT NULL
	
	FOREIGN KEY (FromUserId) REFERENCES scm.Users(id),
	FOREIGN KEY (ToUserId) REFERENCES scm.Users(id)
);
GO
CREATE TABLE scm.KafkaOffsets (
	Groupid BIGINT PRIMARY KEY,
	Offset DECIMAL(18,2) NOT NULL,
);
GO

-- Create a login (if it doesn't exist)
CREATE LOGIN consumerLogin WITH PASSWORD = "$(MSSQL_CONSUMER_PASSWORD)";
GO

-- Map the login to a user in this database
CREATE USER $(MSSQL_CONSUMER_USERNAME) FOR LOGIN consumerLogin
GO

CREATE ROLE consumerRole;
GO
GRANT INSERT ON scm.Statements TO consumerRole;
GO
GRANT SELECT, INSERT, UPDATE ON scm.KafkaOffsets TO consumerRole;
GO
ALTER ROLE consumerRole ADD MEMBER $(MSSQL_CONSUMER_USERNAME);
GO




